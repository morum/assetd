import { createHash } from "node:crypto";
import type { EmbeddingSpace } from "../core/types.ts";
import { spaceIdFor, type VisualModelSpec } from "./presets.ts";
import { l2normalize, type ImageInput, type VisualEmbeddingProvider } from "./types.ts";

const GRID = 4;
const DIMS = 64; // 4x4 cells x RGB = 48, padded to 64

const COLORS: Record<string, [number, number, number]> = {
  red: [1, 0, 0],
  green: [0, 1, 0],
  blue: [0, 0, 1],
  yellow: [1, 1, 0],
  white: [1, 1, 1],
  black: [0.02, 0.02, 0.02],
};

/**
 * Deterministic, model-free provider used by the fast test suite. Images map
 * to a coarse 4x4 color layout; texts naming a color map to that uniform
 * color, anything else to a hash-seeded vector. It exercises the full pipeline
 * without downloading weights. It is not a semantic model.
 */
export class TestHashProvider implements VisualEmbeddingProvider {
  readonly space: EmbeddingSpace;

  constructor(spec: VisualModelSpec) {
    this.space = { id: spaceIdFor(spec), channel: "visual", provider: "test-hash", model: "none", dimensions: DIMS };
  }

  async prepare(): Promise<void> {}

  async isCached(): Promise<boolean> {
    return true;
  }

  async embedImages(images: ImageInput[]): Promise<Float32Array[]> {
    return images.map((img) => {
      const v = new Float32Array(DIMS);
      const counts = new Float32Array(GRID * GRID);
      for (let y = 0; y < img.height; y++) {
        const gy = Math.min(GRID - 1, Math.floor((y * GRID) / img.height));
        for (let x = 0; x < img.width; x++) {
          const gx = Math.min(GRID - 1, Math.floor((x * GRID) / img.width));
          const cell = gy * GRID + gx;
          const o = (y * img.width + x) * 3;
          for (let k = 0; k < 3; k++) v[cell * 3 + k] = v[cell * 3 + k]! + img.data[o + k]! / 255;
          counts[cell]! += 1;
        }
      }
      for (let c = 0; c < GRID * GRID; c++) {
        const n = counts[c] || 1;
        for (let k = 0; k < 3; k++) v[c * 3 + k] = v[c * 3 + k]! / n;
      }
      return l2normalize(v);
    });
  }

  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const v = new Float32Array(DIMS);
      const color = Object.keys(COLORS).find((c) => new RegExp(`\\b${c}\\b`, "i").test(text));
      if (color) {
        const rgb = COLORS[color]!;
        for (let c = 0; c < GRID * GRID; c++) for (let k = 0; k < 3; k++) v[c * 3 + k] = rgb[k]!;
      } else {
        const digest = createHash("sha256").update(text).digest();
        for (let i = 0; i < DIMS; i++) v[i] = (digest[i % digest.length]! / 255) * (i % 2 ? 1 : -1);
      }
      return l2normalize(v);
    });
  }
}
