import fs from "node:fs/promises";
import path from "node:path";
import type { Document, Node as GltfNode, NodeIO } from "@gltf-transform/core";
import type { ModelPrimitive, ModelScene } from "./model-scene.ts";

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const GLB_BUFFER = "@glb.bin";
/** 1x1 white PNG, stands in for a texture file that is missing on disk. */
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

let ioPromise: Promise<NodeIO> | undefined;

/** NodeIO with every official extension plus the Draco and meshopt WASM decoders, created once. */
function gltfIO(): Promise<NodeIO> {
  ioPromise ??= (async () => {
    const [{ NodeIO, Logger }, { ALL_EXTENSIONS }, draco3d, { MeshoptDecoder }] = await Promise.all([
      import("@gltf-transform/core"),
      import("@gltf-transform/extensions"),
      import("draco3dgltf"),
      import("meshoptimizer"),
    ]);
    await MeshoptDecoder.ready;
    const io = new NodeIO()
      .setLogger(new Logger(Logger.Verbosity.SILENT))
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({
        "draco3d.decoder": await draco3d.createDecoderModule(),
        "meshopt.decoder": MeshoptDecoder,
      });
    return io;
  })();
  return ioPromise;
}

interface JsonDocument {
  json: any;
  resources: Record<string, Uint8Array>;
}

function parseGlb(data: Buffer): JsonDocument {
  if (data.byteLength < 20 || data.readUInt32LE(0) !== GLB_MAGIC) throw new Error("Not a GLB file");
  const length = Math.min(data.readUInt32LE(8), data.byteLength);
  let offset = 12;
  let json: any;
  const resources: Record<string, Uint8Array> = {};
  while (offset + 8 <= length) {
    const chunkLength = data.readUInt32LE(offset);
    const chunkType = data.readUInt32LE(offset + 4);
    const chunk = data.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === CHUNK_JSON) json = JSON.parse(chunk.toString("utf8"));
    else if (chunkType === CHUNK_BIN) resources[GLB_BUFFER] = chunk;
    offset += 8 + chunkLength;
  }
  if (!json) throw new Error("GLB has no JSON chunk");
  return { json, resources };
}

const isDataUri = (uri: string) => uri.startsWith("data:");

async function readExternal(dir: string, uri: string): Promise<Uint8Array | null> {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    // Keep the raw URI.
  }
  try {
    return await fs.readFile(path.join(dir, ...decoded.replace(/\\/g, "/").split("/")));
  } catch {
    return null;
  }
}

/**
 * Reads the container and its external resources ourselves so that a missing
 * texture degrades to a placeholder (reported in missingResources) instead of
 * failing the whole model. A missing geometry buffer is still an error.
 */
async function readDocument(
  nativePath: string,
  data: Buffer,
): Promise<{ doc: Document; missing: string[]; format: "glb" | "gltf"; generator: string | null }> {
  const format = data.byteLength >= 4 && data.readUInt32LE(0) === GLB_MAGIC ? "glb" : "gltf";
  const jsonDoc: JsonDocument = format === "glb" ? parseGlb(data) : { json: JSON.parse(data.toString("utf8").replace(/^\uFEFF/, "")), resources: {} };
  const dir = path.dirname(nativePath);
  const missing: string[] = [];
  for (const buffer of jsonDoc.json.buffers ?? []) {
    if (!buffer.uri || isDataUri(buffer.uri)) continue;
    const bytes = await readExternal(dir, buffer.uri);
    if (!bytes) throw new Error(`Missing geometry buffer "${buffer.uri}"`);
    jsonDoc.resources[buffer.uri] = bytes;
  }
  for (const image of jsonDoc.json.images ?? []) {
    if (!image.uri || isDataUri(image.uri)) continue;
    const bytes = await readExternal(dir, image.uri);
    if (bytes) jsonDoc.resources[image.uri] = bytes;
    else {
      missing.push(image.uri);
      jsonDoc.resources[image.uri] = PLACEHOLDER_PNG;
    }
  }
  // Read before parsing: the library replaces asset.generator with its own name.
  const generator = typeof jsonDoc.json.asset?.generator === "string" ? jsonDoc.json.asset.generator : null;
  const io = await gltfIO();
  return { doc: await io.readJSON(jsonDoc as never), missing, format, generator };
}

function transformPoint(m: ArrayLike<number>, x: number, y: number, z: number, out: Float32Array, o: number): void {
  out[o] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  out[o + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  out[o + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
}

const MODE_TRIANGLES = 4;
const MODE_STRIP = 5;
const MODE_FAN = 6;

function triangleIndices(mode: number, source: ArrayLike<number>): Uint32Array {
  if (mode === MODE_TRIANGLES) return Uint32Array.from({ length: source.length - (source.length % 3) }, (_, i) => source[i]!);
  const out: number[] = [];
  for (let i = 2; i < source.length; i++) {
    if (mode === MODE_STRIP) {
      if (i % 2 === 0) out.push(source[i - 2]!, source[i - 1]!, source[i]!);
      else out.push(source[i - 1]!, source[i - 2]!, source[i]!);
    } else if (mode === MODE_FAN) out.push(source[0]!, source[i - 1]!, source[i]!);
  }
  return Uint32Array.from(out);
}

function sceneRoots(doc: Document): GltfNode[] {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (scene) return scene.listChildren();
  // No scene: treat parentless nodes as roots.
  return root.listNodes().filter((n) => !n.getParentNode());
}

export async function loadGltf(nativePath: string, data: Buffer): Promise<ModelScene> {
  const { doc, missing, format, generator } = await readDocument(nativePath, data);
  const root = doc.getRoot();
  const primitives: ModelPrimitive[] = [];
  let vertexCount = 0;
  let triangleCount = 0;
  let hasVertexColors = false;
  let hasMorphTargets = false;

  const visit = (node: GltfNode) => {
    const mesh = node.getMesh();
    if (mesh) {
      const world = node.getWorldMatrix();
      for (const prim of mesh.listPrimitives()) {
        if (prim.listTargets().length > 0) hasMorphTargets = true;
        const position = prim.getAttribute("POSITION");
        if (!position) continue;
        const count = position.getCount();
        vertexCount += count;
        const mode = prim.getMode();
        if (mode !== MODE_TRIANGLES && mode !== MODE_STRIP && mode !== MODE_FAN) continue;
        const positions = new Float32Array(count * 3);
        const el: number[] = [0, 0, 0];
        for (let i = 0; i < count; i++) {
          position.getElement(i, el);
          transformPoint(world, el[0]!, el[1]!, el[2]!, positions, i * 3);
        }
        const indexAccessor = prim.getIndices();
        const rawIndices = indexAccessor ? indexAccessor.getArray()! : Uint32Array.from({ length: count }, (_, i) => i);
        const indices = triangleIndices(mode, rawIndices);
        triangleCount += indices.length / 3;
        const out: ModelPrimitive = { positions, indices, baseColor: [1, 1, 1, 1] };
        const uv = prim.getAttribute("TEXCOORD_0");
        if (uv) {
          out.uvs = new Float32Array(count * 2);
          const t: number[] = [0, 0];
          for (let i = 0; i < count; i++) {
            uv.getElement(i, t);
            out.uvs[i * 2] = t[0]!;
            out.uvs[i * 2 + 1] = t[1]!;
          }
        }
        const color = prim.getAttribute("COLOR_0");
        if (color) {
          hasVertexColors = true;
          out.colors = new Float32Array(count * 3);
          const c: number[] = [1, 1, 1, 1];
          for (let i = 0; i < count; i++) {
            color.getElement(i, c);
            out.colors[i * 3] = c[0]!;
            out.colors[i * 3 + 1] = c[1]!;
            out.colors[i * 3 + 2] = c[2]!;
          }
        }
        const material = prim.getMaterial();
        if (material) {
          out.baseColor = material.getBaseColorFactor() as [number, number, number, number];
          out.materialName = material.getName() || undefined;
          const texture = material.getBaseColorTexture();
          if (texture) {
            const uri = texture.getURI() || null;
            const isMissing = uri !== null && missing.includes(uri);
            out.texture = { data: isMissing ? null : texture.getImage(), mimeType: texture.getMimeType() || null, uri };
          }
        }
        primitives.push(out);
      }
    }
    for (const child of node.listChildren()) visit(child);
  };
  for (const node of sceneRoots(doc)) visit(node);

  const animations = root.listAnimations().map((a, i) => {
    let duration = 0;
    for (const sampler of a.listSamplers()) {
      const input = sampler.getInput();
      if (input) duration = Math.max(duration, input.getMax([0])[0] ?? 0);
    }
    return { name: a.getName() || `animation ${i}`, durationSeconds: duration };
  });
  const skins = root.listSkins();
  return {
    format,
    primitives,
    meshCount: root.listMeshes().length,
    nodeCount: root.listNodes().length,
    materials: [...new Set(root.listMaterials().map((m, i) => m.getName() || `material ${i}`))],
    textures: root.listTextures().map((t) => {
      const uri = t.getURI() || null;
      return { uri, mimeType: t.getMimeType() || null, embedded: uri === null, missing: uri !== null && missing.includes(uri) };
    }),
    animations,
    skinCount: skins.length,
    jointCount: new Set(skins.flatMap((s) => s.listJoints())).size,
    hasMorphTargets,
    hasVertexColors,
    vertexCount,
    triangleCount,
    generator,
    extensionsUsed: root.listExtensionsUsed().map((e) => e.extensionName),
    missingResources: missing,
    units: "meters",
    upAxis: "Y",
  };
}
