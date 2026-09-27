import { AssetdError } from "../core/errors.ts";

export type ModelFamily = "siglip" | "clip" | "test-hash";
export type ModelDtype = "q8" | "fp16" | "fp32";

export interface VisualModelSpec {
  /** Name shown to users ("siglip-base" or the repo id for custom models). */
  name: string;
  family: ModelFamily;
  /** Hugging Face repo id with ONNX weights (transformers.js layout). */
  repo: string;
  dtype: ModelDtype;
  /** Bumped when provider-side preprocessing changes (invalidates vectors). */
  revision: number;
  dimensions: number | null;
}

interface Preset {
  family: ModelFamily;
  repo: string;
  dtype: ModelDtype;
  dimensions: number;
}

export const VISUAL_PRESETS: Record<string, Preset> = {
  "siglip-base": { family: "siglip", repo: "Xenova/siglip-base-patch16-224", dtype: "q8", dimensions: 768 },
  "clip-vit-b32": { family: "clip", repo: "Xenova/clip-vit-base-patch32", dtype: "q8", dimensions: 512 },
  /** Deterministic, model-free provider for tests. Not semantic. */
  "test-hash": { family: "test-hash", repo: "none", dtype: "fp32", dimensions: 64 },
};

/**
 * Resolves the configured model: a preset name, or "<family>:<repo>" for a
 * custom ONNX export of a supported family (e.g. "siglip:Xenova/siglip-large-patch16-384").
 */
export function resolveVisualModel(name: string, dtype?: ModelDtype): VisualModelSpec {
  const preset = VISUAL_PRESETS[name];
  if (preset) return { name, family: preset.family, repo: preset.repo, dtype: dtype ?? preset.dtype, revision: 1, dimensions: preset.dimensions };
  const match = /^(siglip|clip):([\w.-]+\/[\w.-]+)$/.exec(name);
  if (match) return { name: match[2]!, family: match[1] as ModelFamily, repo: match[2]!, dtype: dtype ?? "q8", revision: 1, dimensions: null };
  throw new AssetdError(
    "USAGE_ERROR",
    `Unknown visual model "${name}". Use one of ${Object.keys(VISUAL_PRESETS).join(", ")} or "siglip:<org>/<repo>".`,
  );
}

export function spaceIdFor(spec: VisualModelSpec): string {
  return `${spec.family}:${spec.repo}:${spec.dtype}:r${spec.revision}`;
}
