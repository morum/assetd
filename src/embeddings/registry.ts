import type { AssetdConfig } from "../core/config.ts";
import { resolveVisualModel } from "./presets.ts";
import { TestHashProvider } from "./test-hash-provider.ts";
import { TransformersVisualProvider, type TransformersProviderOptions } from "./transformers-provider.ts";
import type { VisualEmbeddingProvider } from "./types.ts";

/** Creates the configured visual provider. Cheap: weights load on first use. */
export function createVisualProvider(config: AssetdConfig, options: TransformersProviderOptions = {}): VisualEmbeddingProvider {
  const spec = resolveVisualModel(config.models.visual, config.models.dtype);
  if (spec.family === "test-hash") return new TestHashProvider(spec);
  return new TransformersVisualProvider(spec, options);
}
