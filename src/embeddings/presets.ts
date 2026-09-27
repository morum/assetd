import { AssetdError } from "../core/errors.ts";
import type { EmbeddingChannel } from "../core/types.ts";

export type ModelFamily = "siglip" | "clip" | "clap" | "test-hash" | "test-audio";
export type ModelDtype = "q8" | "fp16" | "fp32";

export interface ModelSpec {
  channel: EmbeddingChannel;
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
  revision?: number;
}

export const VISUAL_PRESETS: Record<string, Preset> = {
  "siglip-base": { family: "siglip", repo: "Xenova/siglip-base-patch16-224", dtype: "q8", dimensions: 768 },
  /** ~3% better MRR than siglip-base on the eval set, ~4x slower to index, ~640 MB. */
  "siglip-large": { family: "siglip", repo: "Xenova/siglip-large-patch16-256", dtype: "q8", dimensions: 1024 },
  "clip-vit-b32": { family: "clip", repo: "Xenova/clip-vit-base-patch32", dtype: "q8", dimensions: 512 },
  /** Deterministic, model-free provider for tests. Not semantic. */
  "test-hash": { family: "test-hash", repo: "none", dtype: "fp32", dimensions: 64 },
};

export const AUDIO_PRESETS: Record<string, Preset> = {
  "clap-general": { family: "clap", repo: "Xenova/larger_clap_general", dtype: "q8", dimensions: 512 },
  "clap-htsat-unfused": { family: "clap", repo: "Xenova/clap-htsat-unfused", dtype: "q8", dimensions: 512 },
  /** Deterministic, model-free provider for tests. Not semantic. */
  "test-audio": { family: "test-audio", repo: "none", dtype: "fp32", dimensions: 16 },
};

const CUSTOM: Record<EmbeddingChannel, RegExp> = {
  visual: /^(siglip|clip):([\w.-]+\/[\w.-]+)$/,
  audio: /^(clap):([\w.-]+\/[\w.-]+)$/,
  text: /^$/,
  geometry: /^$/,
};

function resolve(channel: EmbeddingChannel, presets: Record<string, Preset>, name: string, dtype?: ModelDtype): ModelSpec {
  const preset = presets[name];
  if (preset) {
    return { channel, name, family: preset.family, repo: preset.repo, dtype: dtype ?? preset.dtype, revision: preset.revision ?? 1, dimensions: preset.dimensions };
  }
  const match = CUSTOM[channel].exec(name);
  if (match) return { channel, name: match[2]!, family: match[1] as ModelFamily, repo: match[2]!, dtype: dtype ?? "q8", revision: 1, dimensions: null };
  const example = channel === "audio" ? "clap:<org>/<repo>" : "siglip:<org>/<repo>";
  throw new AssetdError("USAGE_ERROR", `Unknown ${channel} model "${name}". Use one of ${Object.keys(presets).join(", ")} or "${example}".`);
}

/**
 * Resolves the configured visual model: a preset name, or "<family>:<repo>"
 * for a custom ONNX export of a supported family (e.g. "siglip:Xenova/siglip-large-patch16-384").
 */
export function resolveVisualModel(name: string, dtype?: ModelDtype): ModelSpec {
  return resolve("visual", VISUAL_PRESETS, name, dtype);
}

export function resolveAudioModel(name: string, dtype?: ModelDtype): ModelSpec {
  return resolve("audio", AUDIO_PRESETS, name, dtype);
}

export function spaceIdFor(spec: ModelSpec): string {
  return `${spec.family}:${spec.repo}:${spec.dtype}:r${spec.revision}`;
}

/** Channel of a stored space id (the family prefix decides). */
export function channelOfSpace(spaceId: string): EmbeddingChannel {
  const family = spaceId.slice(0, spaceId.indexOf(":"));
  return family === "clap" || family === "test-audio" ? "audio" : "visual";
}
