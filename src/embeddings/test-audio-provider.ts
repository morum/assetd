import { createHash } from "node:crypto";
import type { EmbeddingSpace } from "../core/types.ts";
import { spaceIdFor, type ModelSpec } from "./presets.ts";
import { l2normalize, type AudioEmbeddingProvider, type AudioInput } from "./types.ts";

const SEGMENTS = 8;
const DIMS = 16; // per segment: zero-crossing rate, RMS energy

/**
 * Deterministic, model-free audio provider for the fast test suite. Clips map
 * to a coarse (zero-crossing rate, energy) envelope; the text "noise" maps to
 * high-ZCR vectors, "tone"/"hum" to low-ZCR ones, anything else to a hash.
 * It is not a semantic model.
 */
export class TestAudioProvider implements AudioEmbeddingProvider {
  readonly space: EmbeddingSpace;

  constructor(spec: ModelSpec) {
    this.space = { id: spaceIdFor(spec), channel: "audio", provider: "test-audio", model: "none", dimensions: DIMS };
  }

  async prepare(): Promise<void> {}

  async isCached(): Promise<boolean> {
    return true;
  }

  async embedAudio(clips: AudioInput[]): Promise<Float32Array[]> {
    return clips.map(({ samples }) => {
      const v = new Float32Array(DIMS);
      const len = Math.max(1, Math.floor(samples.length / SEGMENTS));
      for (let s = 0; s < SEGMENTS; s++) {
        let zc = 0;
        let sq = 0;
        for (let i = s * len; i < Math.min(samples.length, (s + 1) * len); i++) {
          const x = samples[i]!;
          sq += x * x;
          if (i > s * len && Math.sign(x) !== Math.sign(samples[i - 1]!)) zc++;
        }
        v[s * 2] = zc / len;
        v[s * 2 + 1] = Math.sqrt(sq / len) * 0.1;
      }
      return l2normalize(v);
    });
  }

  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const v = new Float32Array(DIMS);
      if (/\bnoise\b/i.test(text)) for (let s = 0; s < SEGMENTS; s++) v[s * 2] = 1;
      else if (/\b(tone|hum)\b/i.test(text)) for (let s = 0; s < SEGMENTS; s++) (v[s * 2] = 0.05), (v[s * 2 + 1] = 0.05);
      else {
        const d = createHash("sha256").update(text).digest();
        for (let i = 0; i < DIMS; i++) v[i] = d[i]! / 255;
      }
      return l2normalize(v);
    });
  }
}
