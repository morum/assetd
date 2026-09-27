import type { AssetdConfig } from "../core/config.ts";
import type { EmbeddingChannel } from "../core/types.ts";
import { resolveAudioModel, resolveVisualModel, type ModelSpec } from "./presets.ts";
import { TestAudioProvider } from "./test-audio-provider.ts";
import { TestHashProvider } from "./test-hash-provider.ts";
import { TransformersAudioProvider, TransformersVisualProvider, type TransformersProviderOptions } from "./transformers-provider.ts";
import type { AudioEmbeddingProvider, EmbeddingProvider, Providers, VisualEmbeddingProvider } from "./types.ts";

export function visualModelSpec(config: AssetdConfig): ModelSpec {
  return resolveVisualModel(config.models.visual, config.models.dtype);
}

export function audioModelSpec(config: AssetdConfig): ModelSpec {
  return resolveAudioModel(config.models.audio, config.models.audioDtype);
}

/** Creates the configured visual provider. Cheap: weights load on first use. */
export function createVisualProvider(config: AssetdConfig, options: TransformersProviderOptions = {}): VisualEmbeddingProvider {
  const spec = visualModelSpec(config);
  if (spec.family === "test-hash") return new TestHashProvider(spec);
  return new TransformersVisualProvider(spec, options);
}

export function createAudioProvider(config: AssetdConfig, options: TransformersProviderOptions = {}): AudioEmbeddingProvider {
  const spec = audioModelSpec(config);
  if (spec.family === "test-audio") return new TestAudioProvider(spec);
  return new TransformersAudioProvider(spec, options);
}

/** Providers for every channel an enabled processor needs. */
export function createProviders(config: AssetdConfig, options: TransformersProviderOptions = {}): Providers {
  const providers: Providers = { visual: createVisualProvider(config, options) };
  if (config.processors.audio) providers.audio = createAudioProvider(config, options);
  return providers;
}

export function providerForChannel(providers: Providers, channel: EmbeddingChannel): EmbeddingProvider | undefined {
  if (channel === "visual") return providers.visual;
  if (channel === "audio") return providers.audio;
  return undefined;
}

/** The model spec behind a provider's channel (for display). */
export function modelSpecForChannel(config: AssetdConfig, channel: EmbeddingChannel): ModelSpec {
  return channel === "audio" ? audioModelSpec(config) : visualModelSpec(config);
}
