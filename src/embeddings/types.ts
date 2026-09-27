import type { EmbeddingSpace } from "../core/types.ts";

/** Decoded RGB image, 8 bits per channel, row-major, no alpha. */
export interface ImageInput {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface ProviderLoadEvent {
  file: string;
  loaded?: number;
  total?: number;
  status: "download" | "progress" | "done" | "ready";
}

/**
 * A model that embeds images and text into one shared space
 * (SigLIP/CLIP style). Vectors returned are L2-normalized.
 *
 * Implementations load lazily: constructing a provider must be cheap so that
 * commands which never embed (status, inspect) pay nothing.
 */
export interface VisualEmbeddingProvider {
  readonly space: EmbeddingSpace;
  embedImages(inputs: ImageInput[]): Promise<Float32Array[]>;
  embedTexts(texts: string[]): Promise<Float32Array[]>;
  /** Downloads/loads weights without embedding anything. */
  prepare(parts?: { text?: boolean; vision?: boolean }): Promise<void>;
  /** Whether weights are available locally (no network needed). */
  isCached(): Promise<boolean>;
}

export function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const n = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}
