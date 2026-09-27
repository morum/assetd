import type { EmbeddingRequest } from "../processors/types.ts";
import { l2normalize, type AudioEmbeddingProvider, type Providers, type VisualEmbeddingProvider } from "./types.ts";

type VisualRequest = Extract<EmbeddingRequest, { channel: "visual" }>;
type AudioRequest = Extract<EmbeddingRequest, { channel: "audio" }>;

/** Normalized mean of several vectors (multi-view embedding). */
export function meanVector(vectors: Float32Array[]): Float32Array {
  const sum = new Float32Array(vectors[0]!.length);
  for (const v of vectors) for (let i = 0; i < v.length; i++) sum[i] = sum[i]! + v[i]!;
  return l2normalize(sum);
}

/** One vector per request; multi-view requests are embedded in the same batch and averaged. */
export async function embedVisualRequests(provider: VisualEmbeddingProvider, requests: VisualRequest[]): Promise<Float32Array[]> {
  const images = requests.flatMap((r) => (r.input.type === "image" ? [r.input.image] : r.input.images));
  const vectors = await provider.embedImages(images);
  let k = 0;
  return requests.map((r) => {
    const n = r.input.type === "image" ? 1 : r.input.images.length;
    const own = vectors.slice(k, k + n);
    k += n;
    return n === 1 ? own[0]! : meanVector(own);
  });
}

export function embedAudioRequests(provider: AudioEmbeddingProvider, requests: AudioRequest[]): Promise<Float32Array[]> {
  return provider.embedAudio(requests.map((r) => r.input.audio));
}

/** Embeds requests of one channel with the matching provider. */
export function embedRequests(providers: Providers, channel: string, requests: EmbeddingRequest[]): Promise<Float32Array[]> {
  if (channel === "visual") return embedVisualRequests(providers.visual, requests as VisualRequest[]);
  if (channel === "audio" && providers.audio) return embedAudioRequests(providers.audio, requests as AudioRequest[]);
  return Promise.reject(new Error(`No embedding provider configured for channel "${channel}"`));
}
