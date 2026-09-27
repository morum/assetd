import type { EmbeddingSpace } from "../core/types.ts";

/** Decoded RGB image, 8 bits per channel, row-major, no alpha. */
export interface ImageInput {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Decoded mono PCM in [-1, 1] at its native sample rate. */
export interface AudioInput {
  samples: Float32Array;
  sampleRate: number;
}

export interface ProviderLoadEvent {
  file: string;
  loaded?: number;
  total?: number;
  status: "download" | "progress" | "done" | "ready";
}

/**
 * A model with a text tower and one media tower sharing a space
 * (SigLIP/CLIP for images, CLAP for audio). Vectors are L2-normalized.
 *
 * Implementations load lazily: constructing a provider must be cheap so that
 * commands which never embed (status, inspect) pay nothing.
 */
export interface EmbeddingProvider {
  readonly space: EmbeddingSpace;
  embedTexts(texts: string[]): Promise<Float32Array[]>;
  /** Downloads/loads weights without embedding anything. */
  prepare(parts?: { text?: boolean; media?: boolean }): Promise<void>;
  /** Whether weights are available locally (no network needed). */
  isCached(): Promise<boolean>;
}

export interface VisualEmbeddingProvider extends EmbeddingProvider {
  embedImages(inputs: ImageInput[]): Promise<Float32Array[]>;
}

export interface AudioEmbeddingProvider extends EmbeddingProvider {
  embedAudio(inputs: AudioInput[]): Promise<Float32Array[]>;
}

/** One provider per embedding channel that the enabled processors need. */
export interface Providers {
  visual: VisualEmbeddingProvider;
  audio?: AudioEmbeddingProvider;
}

export function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const n = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}
