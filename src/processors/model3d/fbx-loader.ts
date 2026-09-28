import fs from "node:fs/promises";
import path from "node:path";
import { resolveObjectURL } from "node:buffer";
import type { ModelPrimitive, ModelScene, ModelTexture } from "./model-scene.ts";

type Three = typeof import("three");
type FBXLoaderModule = typeof import("three/examples/jsm/loaders/FBXLoader.js");

let modules: Promise<[Three, FBXLoaderModule]> | undefined;

/** three.js is only loaded when a project actually contains FBX files. */
function loadThree(): Promise<[Three, FBXLoaderModule]> {
  modules ??= Promise.all([import("three"), import("three/examples/jsm/loaders/FBXLoader.js")]);
  return modules;
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".tga": "image/x-tga", ".bmp": "image/bmp", ".webp": "image/webp", ".tif": "image/tiff", ".tiff": "image/tiff" };

/** FBX version: binary header ("Kaydara FBX Binary  \0" + uint32) or the ASCII comment line. */
export function fbxVersion(data: Buffer): number | null {
  if (data.subarray(0, 18).toString("latin1") === "Kaydara FBX Binary") return data.readUInt32LE(23);
  const m = /FBX (\d)\.(\d)\.(\d)/.exec(data.subarray(0, 200).toString("latin1"));
  return m ? Number(m[1]) * 1000 + Number(m[2]) * 100 + Number(m[3]) * 10 : null;
}

async function tryRead(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

/**
 * FBX files often store the exporting machine's absolute path
 * ("C:\\Users\\artist\\Desktop\\wood.png"). Try the path as written (relative
 * to the model), then the bare file name next to the model and in common
 * texture folders.
 */
export async function resolveTexture(modelDir: string, reference: string): Promise<Buffer | null> {
  const unified = reference.replace(/\\/g, "/");
  const base = unified.slice(unified.lastIndexOf("/") + 1);
  const candidates = [
    ...(/^[A-Za-z]:\//.test(unified) || unified.startsWith("/") ? [] : [path.join(modelDir, ...unified.split("/"))]),
    path.join(modelDir, base),
    path.join(modelDir, "Textures", base),
    path.join(modelDir, "textures", base),
    path.join(modelDir, "..", "Textures", base),
    path.join(modelDir, "..", "textures", base),
  ];
  for (const c of candidates) {
    const bytes = await tryRead(c);
    if (bytes) return bytes;
  }
  return null;
}

/**
 * Repairs two exporter quirks before three.js's ASCII FBX parser sees them
 * (both occur in every model of Kenney's furniture and nature kits):
 *
 * 1. The parser finds the end of each block by its exact tab indentation; a
 *    closing brace indented one tab too deep nests the following blocks in the
 *    wrong parent (UVs vanish). Every line is re-indented from the actual brace
 *    depth.
 * 2. An array line ending in "," is kept as text while the parser waits for a
 *    continuation line; when the block closes right after, the array never
 *    becomes numbers (material indices end up as characters). That dangling
 *    comma is dropped.
 *
 * Values are otherwise untouched.
 */
export function normalizeAsciiFbx(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let depth = 0;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (line.startsWith("}")) depth = Math.max(0, depth - 1);
    if (line.startsWith("a:") && line.endsWith(",")) {
      let j = i + 1;
      while (j < lines.length && lines[j] === "") j++;
      if (j >= lines.length || lines[j]!.startsWith("}")) line = line.slice(0, -1);
    }
    out.push(line === "" ? "" : "\t".repeat(depth) + line);
    if (line.endsWith("{") && !line.startsWith(";")) depth++;
  }
  return out.join("\n");
}

/** Runs `fn` with the few browser globals FBXLoader touches, restoring them afterwards. */
function withLoaderShims<T>(fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const hadWindow = "window" in g;
  const warn = console.warn;
  // Cameras read window.innerWidth/innerHeight; the value is irrelevant here.
  if (!hadWindow) g.window = { innerWidth: 256, innerHeight: 256 };
  // Per-file loader notices (e.g. Z-up conversion) would flood stderr on large projects.
  console.warn = () => undefined;
  try {
    return fn();
  } finally {
    console.warn = warn;
    if (!hadWindow) delete g.window;
  }
}

/**
 * Autodesk FBX (binary and ASCII, 7.x; 6.1+ as far as three.js supports it),
 * read with three.js's pure-JS FBXLoader and converted to the shared scene.
 * Geometry is converted to meters using the file's UnitScaleFactor; Z-up
 * files are rotated to Y-up by the loader.
 */
export async function loadFbx(nativePath: string, data: Buffer): Promise<ModelScene> {
  const version = fbxVersion(data);
  if (version !== null && version < 6100) throw new Error(`FBX ${version / 1000} is too old (6.1 or newer is supported)`);
  const [THREE, { FBXLoader }] = await loadThree();

  // Capture texture references instead of loading images (three.js would need a DOM).
  const requested = new Map<InstanceType<Three["Texture"]>, string>();
  const manager = new THREE.LoadingManager();
  const capture = {
    path: "",
    setPath(p: string | undefined) {
      this.path = p ?? "";
      return this;
    },
    load(url: string) {
      const texture = new THREE.Texture();
      requested.set(texture, url);
      return texture;
    },
  };
  manager.addHandler(/./, capture as never);

  const binary = data.subarray(0, 18).toString("latin1") === "Kaydara FBX Binary";
  const source = binary ? data : Buffer.from(normalizeAsciiFbx(data.toString("utf8")), "utf8");
  const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
  const root = withLoaderShims(() => new FBXLoader(manager).parse(buffer, ""));
  root.updateMatrixWorld(true);
  const unitScale = typeof root.userData.unitScaleFactor === "number" ? root.userData.unitScaleFactor : 1;
  // FBX units are centimeters scaled by UnitScaleFactor; the scene is in meters.
  const toMeters = unitScale / 100;

  const modelDir = path.dirname(nativePath);
  const missing: string[] = [];
  const textureCache = new Map<string, ModelTexture>();
  const textureFor = async (url: string): Promise<ModelTexture> => {
    let t = textureCache.get(url);
    if (t) return t;
    let bytes: Buffer | null = null;
    let mimeType: string | null = null;
    if (url.startsWith("blob:")) {
      const blob = resolveObjectURL(url);
      if (blob) {
        bytes = Buffer.from(await blob.arrayBuffer());
        mimeType = blob.type || null;
      }
      URL.revokeObjectURL(url);
      t = { data: bytes, mimeType, uri: null };
    } else {
      bytes = await resolveTexture(modelDir, url);
      if (!bytes) missing.push(url);
      t = { data: bytes, mimeType: MIME[path.extname(url).toLowerCase()] ?? null, uri: url };
    }
    textureCache.set(url, t);
    return t;
  };

  const primitives: ModelPrimitive[] = [];
  const materials = new Set<string>();
  let vertexCount = 0;
  let triangleCount = 0;
  let meshCount = 0;
  let nodeCount = 0;
  let hasVertexColors = false;
  let hasMorphTargets = false;
  const bones = new Set<unknown>();
  let skinCount = 0;
  const meshes: InstanceType<Three["Mesh"]>[] = [];
  root.traverse((o) => {
    nodeCount++;
    if ((o as InstanceType<Three["Mesh"]>).isMesh) meshes.push(o as InstanceType<Three["Mesh"]>);
  });

  for (const mesh of meshes) {
    meshCount++;
    const skinned = mesh as unknown as { isSkinnedMesh?: boolean; skeleton?: { bones: unknown[] } };
    if (skinned.isSkinnedMesh && skinned.skeleton) {
      skinCount++;
      for (const b of skinned.skeleton.bones) bones.add(b);
    }
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    if (!position) continue;
    if (geometry.morphAttributes.position?.length) hasMorphTargets = true;
    const count = position.count;
    vertexCount += count;
    const world = mesh.matrixWorld.elements;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
      positions[i * 3] = (world[0]! * x + world[4]! * y + world[8]! * z + world[12]!) * toMeters;
      positions[i * 3 + 1] = (world[1]! * x + world[5]! * y + world[9]! * z + world[13]!) * toMeters;
      positions[i * 3 + 2] = (world[2]! * x + world[6]! * y + world[10]! * z + world[14]!) * toMeters;
    }
    const uvAttr = geometry.attributes.uv;
    const uvs = uvAttr ? new Float32Array(count * 2) : undefined;
    if (uvAttr && uvs) {
      // FBX UVs have a bottom-left origin (like OBJ); the scene uses glTF's top-left.
      for (let i = 0; i < count; i++) (uvs[i * 2] = uvAttr.getX(i)), (uvs[i * 2 + 1] = 1 - uvAttr.getY(i));
    }
    const colorAttr = geometry.attributes.color;
    const colors = colorAttr ? new Float32Array(count * 3) : undefined;
    if (colorAttr && colors) {
      hasVertexColors = true;
      for (let i = 0; i < count; i++) (colors[i * 3] = colorAttr.getX(i)), (colors[i * 3 + 1] = colorAttr.getY(i)), (colors[i * 3 + 2] = colorAttr.getZ(i));
    }
    const allIndices = geometry.index ? Array.from(geometry.index.array as ArrayLike<number>) : Array.from({ length: count }, (_, i) => i);
    const materialList = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // Multi-material meshes split their index range into groups (FBXLoader often
    // emits one group per polygon); gather them into one primitive per material.
    const groups = geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count: allIndices.length, materialIndex: 0 }];
    const byMaterial = new Map<number, number[]>();
    for (const group of groups) {
      const key = Number(group.materialIndex ?? 0);
      const list = byMaterial.get(key) ?? [];
      for (let k = group.start; k < group.start + group.count && k < allIndices.length; k++) list.push(allIndices[k]!);
      byMaterial.set(key, list);
    }
    for (const [materialIndex, idx] of byMaterial) {
      const tris = Math.floor(idx.length / 3);
      if (tris === 0) continue;
      triangleCount += tris;
      const material = materialList[materialIndex] as unknown as
        | { name?: string; color?: { r: number; g: number; b: number }; opacity?: number; map?: InstanceType<Three["Texture"]> | null }
        | undefined;
      if (material?.name) materials.add(material.name);
      const prim: ModelPrimitive = {
        positions,
        indices: Uint32Array.from(idx.slice(0, tris * 3)),
        baseColor: material?.color ? [material.color.r, material.color.g, material.color.b, material.opacity ?? 1] : [1, 1, 1, 1],
      };
      if (uvs) prim.uvs = uvs;
      if (colors) prim.colors = colors;
      if (material?.name) prim.materialName = material.name;
      const url = material?.map ? requested.get(material.map) : undefined;
      if (url) prim.texture = await textureFor(url);
      primitives.push(prim);
    }
  }

  const animations = (root.animations ?? []).map((clip, i) => ({ name: clip.name || `animation ${i}`, durationSeconds: Math.max(0, clip.duration) }));
  return {
    format: "fbx",
    primitives,
    meshCount,
    nodeCount,
    materials: [...materials],
    textures: [...textureCache.values()].map((t) => ({ uri: t.uri, mimeType: t.mimeType, embedded: t.uri === null, missing: t.data === null })),
    animations,
    skinCount,
    jointCount: bones.size,
    hasMorphTargets,
    hasVertexColors,
    vertexCount,
    triangleCount,
    generator: null,
    extensionsUsed: [],
    missingResources: [...new Set(missing)],
    units: "meters",
    upAxis: "Y",
    ...(version !== null ? { sourceVersion: `${Math.floor(version / 1000)}.${Math.floor((version % 1000) / 100)}` } : {}),
    sourceUnitScale: unitScale,
  };
}
