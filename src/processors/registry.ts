import type { AssetdConfig } from "../core/config.ts";
import type { FileInfo } from "../core/types.ts";
import { AudioProcessor } from "./audio/audio-processor.ts";
import { ImageProcessor } from "./image/image-processor.ts";
import { EMBED_VIEW_SETS, Model3DProcessor } from "./model3d/model3d-processor.ts";
import type { AssetProcessor } from "./types.ts";

export class ProcessorRegistry {
  private readonly processors: AssetProcessor[] = [];

  register(processor: AssetProcessor): this {
    if (this.processors.some((p) => p.id === processor.id)) throw new Error(`Processor "${processor.id}" already registered`);
    this.processors.push(processor);
    return this;
  }

  list(): readonly AssetProcessor[] {
    return this.processors;
  }

  byId(id: string): AssetProcessor | undefined {
    return this.processors.find((p) => p.id === id);
  }

  /** Cheap check on the extension only (used before stat during discovery). */
  mayHandle(extension: string): boolean {
    return this.processors.some((p) => p.extensions.includes(extension));
  }

  /** First registered processor that supports the file. */
  forFile(file: FileInfo): AssetProcessor | undefined {
    return this.processors.find((p) => p.supports(file));
  }
}

/**
 * Processors enabled by configuration. Image, audio and 3D exist in this release;
 * other kinds are accepted in config for forward compatibility and reported
 * as unavailable.
 */
export function createProcessorRegistry(config: AssetdConfig): ProcessorRegistry {
  const registry = new ProcessorRegistry();
  if (config.processors.image) registry.register(new ImageProcessor());
  if (config.processors.audio) registry.register(new AudioProcessor());
  if (config.processors.model3d) registry.register(new Model3DProcessor({ views: EMBED_VIEW_SETS[config.model3d.views] }));
  return registry;
}

export function unavailableProcessors(config: AssetdConfig): string[] {
  const { image: _image, audio: _audio, model3d: _model3d, ...rest } = config.processors;
  return Object.entries(rest)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}
