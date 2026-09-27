import fs from "node:fs/promises";
import path from "node:path";
import type { ModelPrimitive, ModelScene, ModelTexture } from "./model-scene.ts";

interface MtlMaterial {
  name: string;
  color: [number, number, number, number];
  mapKd?: string;
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".tga": "image/x-tga", ".bmp": "image/bmp" };

/** Texture paths in MTL files often carry options ("-s 1 1 1 tex.png") and Windows separators. */
function mapPath(rest: string): string {
  const tokens = rest.trim().split(/\s+/);
  const optionArgs: Record<string, number> = { "-s": 3, "-o": 3, "-t": 3, "-mm": 2, "-bm": 1, "-boost": 1, "-texres": 1, "-blendu": 1, "-blendv": 1, "-clamp": 1, "-imfchan": 1, "-cc": 1 };
  let i = 0;
  while (i < tokens.length && tokens[i]!.startsWith("-") && optionArgs[tokens[i]!] !== undefined) i += 1 + optionArgs[tokens[i]!]!;
  return tokens.slice(i).join(" ").replace(/\\/g, "/");
}

function parseMtl(text: string): MtlMaterial[] {
  const materials: MtlMaterial[] = [];
  let current: MtlMaterial | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const space = line.search(/\s/);
    const key = (space < 0 ? line : line.slice(0, space)).toLowerCase();
    const rest = space < 0 ? "" : line.slice(space + 1);
    if (key === "newmtl") materials.push((current = { name: rest.trim(), color: [1, 1, 1, 1] }));
    else if (!current) continue;
    else if (key === "kd") {
      const [r, g, b] = rest.trim().split(/\s+/).map(Number);
      current.color = [r ?? 1, g ?? r ?? 1, b ?? r ?? 1, current.color[3]];
    } else if (key === "d") current.color[3] = Number(rest) || 1;
    else if (key === "tr") current.color[3] = 1 - (Number(rest) || 0);
    else if (key === "map_kd") current.mapKd = mapPath(rest);
  }
  return materials;
}

async function tryRead(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

/**
 * Wavefront OBJ + MTL. Faces are fan-triangulated; negative (relative) indices
 * are supported. OBJ has no units or up axis, so both are reported as unknown.
 */
export async function loadObj(nativePath: string, data: Buffer): Promise<ModelScene> {
  const dir = path.dirname(nativePath);
  const v: number[] = [];
  const vc: number[] = [];
  const vt: number[] = [];
  const missing: string[] = [];
  const materials = new Map<string, MtlMaterial>();
  const objects = new Set<string>();
  // Faces grouped by material: arrays of [positionIndex, uvIndex] per corner.
  const groups = new Map<string, { corners: [number, number][] }>();
  let currentMaterial = "";
  let triangleCount = 0;
  let hasVertexColors = false;

  const group = () => {
    let g = groups.get(currentMaterial);
    if (!g) groups.set(currentMaterial, (g = { corners: [] }));
    return g;
  };

  for (const raw of data.toString("utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const key = parts[0];
    if (key === "v") {
      v.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
      if (parts.length >= 7) {
        hasVertexColors = true;
        vc.push(Number(parts[4]), Number(parts[5]), Number(parts[6]));
      } else vc.push(NaN, NaN, NaN);
    } else if (key === "vt") vt.push(Number(parts[1]), Number(parts[2] ?? 0));
    else if (key === "f") {
      const vertexTotal = v.length / 3;
      const uvTotal = vt.length / 2;
      const corners = parts.slice(1).map((c): [number, number] => {
        const [pi, ti] = c.split("/");
        const p = Number(pi);
        const t = ti ? Number(ti) : NaN;
        return [p < 0 ? vertexTotal + p : p - 1, Number.isNaN(t) ? -1 : t < 0 ? uvTotal + t : t - 1];
      });
      const g = group();
      for (let i = 2; i < corners.length; i++) {
        g.corners.push(corners[0]!, corners[i - 1]!, corners[i]!);
        triangleCount++;
      }
    } else if (key === "usemtl") currentMaterial = line.slice(6).trim();
    else if (key === "o" || key === "g") objects.add(line.slice(2).trim() || `${key} ${objects.size}`);
    else if (key === "mtllib") {
      for (const lib of line.slice(6).trim().split(/\s+(?=\S+\.mtl\b)/i)) {
        const rel = lib.replace(/\\/g, "/");
        const text = await tryRead(path.join(dir, ...rel.split("/")));
        if (!text) {
          missing.push(rel);
          continue;
        }
        for (const m of parseMtl(text.toString("utf8"))) materials.set(m.name, { ...m, mapKd: m.mapKd ? path.posix.join(path.posix.dirname(rel), m.mapKd) : undefined });
      }
    }
  }

  const textureCache = new Map<string, ModelTexture>();
  const textureFor = async (rel: string): Promise<ModelTexture> => {
    let t = textureCache.get(rel);
    if (!t) {
      const bytes = await tryRead(path.join(dir, ...rel.split("/")));
      if (!bytes) missing.push(rel);
      t = { data: bytes, mimeType: MIME[path.extname(rel).toLowerCase()] ?? null, uri: rel };
      textureCache.set(rel, t);
    }
    return t;
  };

  const primitives: ModelPrimitive[] = [];
  for (const [name, g] of groups) {
    const n = g.corners.length;
    const positions = new Float32Array(n * 3);
    const uvs = new Float32Array(n * 2);
    const colors = hasVertexColors ? new Float32Array(n * 3) : undefined;
    let anyUv = false;
    g.corners.forEach(([pi, ti], k) => {
      positions[k * 3] = v[pi * 3] ?? NaN;
      positions[k * 3 + 1] = v[pi * 3 + 1] ?? NaN;
      positions[k * 3 + 2] = v[pi * 3 + 2] ?? NaN;
      if (ti >= 0) {
        anyUv = true;
        uvs[k * 2] = vt[ti * 2] ?? 0;
        // OBJ uses a bottom-left UV origin; the scene uses glTF's top-left.
        uvs[k * 2 + 1] = 1 - (vt[ti * 2 + 1] ?? 0);
      }
      if (colors) for (let c = 0; c < 3; c++) colors[k * 3 + c] = Number.isNaN(vc[pi * 3 + c]!) ? 1 : vc[pi * 3 + c]!;
    });
    const material = materials.get(name);
    const prim: ModelPrimitive = {
      positions,
      indices: Uint32Array.from({ length: n }, (_, i) => i),
      baseColor: material?.color ?? [1, 1, 1, 1],
    };
    if (anyUv) prim.uvs = uvs;
    if (colors) prim.colors = colors;
    if (name) prim.materialName = name;
    if (material?.mapKd) prim.texture = await textureFor(material.mapKd);
    primitives.push(prim);
  }

  return {
    format: "obj",
    primitives,
    meshCount: Math.max(objects.size, primitives.length > 0 ? 1 : 0),
    nodeCount: objects.size,
    materials: [...materials.keys()],
    textures: [...textureCache.values()].map((t) => ({ uri: t.uri, mimeType: t.mimeType, embedded: false, missing: t.data === null })),
    animations: [],
    skinCount: 0,
    jointCount: 0,
    hasMorphTargets: false,
    hasVertexColors,
    vertexCount: v.length / 3,
    triangleCount,
    generator: null,
    extensionsUsed: [],
    missingResources: [...new Set(missing)],
    units: null,
    upAxis: null,
  };
}
