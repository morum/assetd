/**
 * Format-neutral scene produced by the glTF and OBJ loaders. Metadata is
 * derived from it, and the preview renderer draws it, so both see the same
 * geometry. Positions are in world space (node transforms applied).
 */
export interface ModelTexture {
  /** Encoded image bytes (PNG/JPEG/WebP...), or null when unavailable. */
  data: Uint8Array | null;
  mimeType: string | null;
  /** URI as written in the file, or null for embedded images. */
  uri: string | null;
}

export interface ModelPrimitive {
  /** xyz triples, world space. */
  positions: Float32Array;
  /** Triangle vertex indices. */
  indices: Uint32Array;
  /** uv pairs (optional). */
  uvs?: Float32Array;
  /** rgb triples in 0..1 (optional vertex colors). */
  colors?: Float32Array;
  /** Base color factor, linear 0..1 RGBA. */
  baseColor: [number, number, number, number];
  texture?: ModelTexture;
  materialName?: string;
}

export interface ModelAnimation {
  name: string;
  durationSeconds: number;
}

export interface ModelScene {
  format: "glb" | "gltf" | "obj" | "fbx";
  primitives: ModelPrimitive[];
  /** Mesh definitions (glTF meshes, OBJ objects/groups). */
  meshCount: number;
  nodeCount: number;
  materials: string[];
  textures: { uri: string | null; mimeType: string | null; embedded: boolean; missing: boolean }[];
  animations: ModelAnimation[];
  jointCount: number;
  skinCount: number;
  hasMorphTargets: boolean;
  hasVertexColors: boolean;
  /** Vertices and triangles as drawn (instanced meshes count per instance). */
  vertexCount: number;
  triangleCount: number;
  generator: string | null;
  extensionsUsed: string[];
  /** Referenced files that could not be found. */
  missingResources: string[];
  units: "meters" | null;
  upAxis: "Y" | null;
  /** Source format version (FBX: "7.4"). */
  sourceVersion?: string;
  /** FBX UnitScaleFactor as stored in the file (1 = centimeters); geometry is converted to meters. */
  sourceUnitScale?: number;
}

export interface BoundingBox {
  min: [number, number, number];
  max: [number, number, number];
}

export function boundingBox(scene: ModelScene): BoundingBox | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const p of scene.primitives) {
    for (let i = 0; i < p.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = p.positions[i + k]!;
        if (!Number.isFinite(v)) continue;
        if (v < min[k]!) min[k] = v;
        if (v > max[k]!) max[k] = v;
        any = true;
      }
    }
  }
  return any ? { min, max } : null;
}

const round = (v: number) => Math.round(v * 10_000) / 10_000;
const cap = <T>(list: T[], n = 50) => list.slice(0, n);

/** Metadata stored in the index (bounded lists, rounded numbers). */
export function describeScene(scene: ModelScene): Record<string, unknown> {
  const box = boundingBox(scene);
  return {
    format: scene.format,
    vertexCount: scene.vertexCount,
    triangleCount: scene.triangleCount,
    meshCount: scene.meshCount,
    nodeCount: scene.nodeCount,
    materialCount: scene.materials.length,
    materials: cap(scene.materials),
    textureCount: scene.textures.length,
    textures: cap(scene.textures),
    boundingBox: box ? { min: box.min.map(round), max: box.max.map(round) } : null,
    dimensions: box ? box.max.map((v, i) => round(v - box.min[i]!)) : null,
    hasAnimations: scene.animations.length > 0,
    animations: cap(scene.animations.map((a) => ({ name: a.name, durationSeconds: round(a.durationSeconds) }))),
    hasSkeleton: scene.skinCount > 0,
    jointCount: scene.jointCount,
    hasMorphTargets: scene.hasMorphTargets,
    hasVertexColors: scene.hasVertexColors,
    units: scene.units,
    upAxis: scene.upAxis,
    generator: scene.generator,
    extensionsUsed: scene.extensionsUsed,
    missingResources: cap(scene.missingResources),
    ...(scene.sourceVersion !== undefined ? { sourceVersion: scene.sourceVersion } : {}),
    ...(scene.sourceUnitScale !== undefined ? { sourceUnitScale: scene.sourceUnitScale } : {}),
  };
}
