import fs from "node:fs";
import path from "node:path";
import { AssetdError, errorMessage } from "../core/errors.ts";
import type { EmbeddingSpace } from "../core/types.ts";
import { resampleLinear } from "./audio-utils.ts";
import { isOffline, resolveModelCacheDir } from "./model-cache.ts";
import { spaceIdFor, type ModelSpec } from "./presets.ts";
import {
  l2normalize,
  type AudioEmbeddingProvider,
  type AudioInput,
  type ImageInput,
  type ProviderLoadEvent,
  type VisualEmbeddingProvider,
} from "./types.ts";

type Transformers = typeof import("@huggingface/transformers");
type Tensor = import("@huggingface/transformers").Tensor;

export interface TransformersProviderOptions {
  env?: NodeJS.ProcessEnv;
  onProgress?: (event: ProviderLoadEvent) => void;
}

const DTYPE_SUFFIX = { q8: "_quantized", fp16: "_fp16", fp32: "" } as const;

let libPromise: Promise<Transformers> | undefined;

/**
 * Shared machinery for dual-encoder models running on ONNX Runtime (CPU)
 * through transformers.js: pure Node.js, the same code path on Windows and
 * Linux. The text tower and the media tower load independently, so a text
 * query never pays for loading the media weights.
 */
abstract class TransformersDualEncoder {
  readonly space: EmbeddingSpace;
  protected readonly spec: ModelSpec;
  protected readonly env: NodeJS.ProcessEnv;
  private readonly onProgress: ((e: ProviderLoadEvent) => void) | undefined;
  /** Files absent from the cache when loading began: only these are real downloads. */
  private downloading = new Set<string>();
  private text?: Promise<{ tokenizer: any; model: any }>;
  private media?: Promise<{ processor: any; model: any }>;

  /** ONNX file stem of the media tower ("vision_model", "audio_model"). */
  protected abstract readonly mediaTower: string;
  protected abstract textModelClass(lib: Transformers): any;
  protected abstract mediaModelClass(lib: Transformers): any;
  protected abstract textOutput(): string;
  protected abstract mediaOutput(): string;
  protected textPadding(): "max_length" | true {
    return true;
  }

  constructor(spec: ModelSpec, options: TransformersProviderOptions = {}) {
    this.spec = spec;
    this.env = options.env ?? process.env;
    this.onProgress = options.onProgress;
    this.space = { id: spaceIdFor(spec), channel: spec.channel, provider: spec.family, model: spec.repo, dimensions: spec.dimensions };
  }

  get cacheDir(): string {
    return resolveModelCacheDir(this.env);
  }

  requiredFiles(part: "text" | "media"): string[] {
    const suffix = DTYPE_SUFFIX[this.spec.dtype];
    return part === "text"
      ? ["config.json", "tokenizer.json", "tokenizer_config.json", `onnx/text_model${suffix}.onnx`]
      : ["config.json", "preprocessor_config.json", `onnx/${this.mediaTower}${suffix}.onnx`];
  }

  private missingFiles(): Set<string> {
    const base = path.join(this.cacheDir, ...this.spec.repo.split("/"));
    const files = [...this.requiredFiles("text"), ...this.requiredFiles("media")];
    return new Set(files.filter((f) => !fs.existsSync(path.join(base, ...f.split("/")))));
  }

  async isCached(): Promise<boolean> {
    return this.missingFiles().size === 0;
  }

  protected loadLib(): Promise<Transformers> {
    this.downloading = new Set([...this.downloading, ...this.missingFiles()]);
    libPromise ??= import("@huggingface/transformers");
    return libPromise.then((lib) => {
      lib.env.cacheDir = this.cacheDir;
      lib.env.allowLocalModels = false;
      lib.env.allowRemoteModels = !isOffline(this.env);
      return lib;
    });
  }

  private progress = (p: any) => {
    if (!this.onProgress || !p || typeof p !== "object" || !this.downloading.has(String(p.file))) return;
    const status = p.status === "initiate" ? "download" : p.status;
    if (status === "download" || status === "progress" || status === "done" || status === "ready") {
      this.onProgress({ file: String(p.file ?? p.name ?? ""), loaded: p.loaded, total: p.total, status });
    }
  };

  /** ONNX Runtime session options; ASSETD_THREADS caps intra-op threads (default: runtime decides). */
  private sessionOptions(): Record<string, unknown> {
    const threads = Number(this.env.ASSETD_THREADS);
    return Number.isInteger(threads) && threads > 0 ? { intraOpNumThreads: threads, interOpNumThreads: 1 } : {};
  }

  private wrapLoad<T>(what: string, promise: Promise<T>): Promise<T> {
    return promise.catch((err: unknown) => {
      const offline = isOffline(this.env);
      throw new AssetdError(
        "MODEL_UNAVAILABLE",
        `Could not load ${what} for ${this.spec.repo} (${this.spec.dtype})` +
          (offline ? " in offline mode; run `assetd models pull` while online first" : "") +
          `: ${errorMessage(err)}`,
        { model: this.spec.repo, dtype: this.spec.dtype, cacheDir: this.cacheDir, offline },
        { cause: err },
      );
    });
  }

  private modelOptions() {
    return { progress_callback: this.progress, dtype: this.spec.dtype, device: "cpu" as const, session_options: this.sessionOptions() };
  }

  protected loadText() {
    this.text ??= this.wrapLoad(
      "text encoder",
      this.loadLib().then(async (lib) => {
        const tokenizer = await lib.AutoTokenizer.from_pretrained(this.spec.repo, { progress_callback: this.progress });
        const model = await this.textModelClass(lib).from_pretrained(this.spec.repo, this.modelOptions());
        return { tokenizer, model };
      }),
    );
    return this.text;
  }

  protected loadMedia() {
    this.media ??= this.wrapLoad(
      `${this.spec.channel} encoder`,
      this.loadLib().then(async (lib) => {
        const processor = await lib.AutoProcessor.from_pretrained(this.spec.repo, { progress_callback: this.progress });
        const model = await this.mediaModelClass(lib).from_pretrained(this.spec.repo, this.modelOptions());
        return { processor, model };
      }),
    );
    return this.media;
  }

  async prepare(parts: { text?: boolean; media?: boolean } = { text: true, media: true }): Promise<void> {
    await Promise.all([parts.text ? this.loadText() : null, parts.media ? this.loadMedia() : null]);
  }

  protected toVectors(tensor: Tensor): Float32Array[] {
    const [rows, dims] = tensor.dims as [number, number];
    const data = tensor.data as Float32Array;
    this.space.dimensions ??= dims;
    const out: Float32Array[] = [];
    for (let r = 0; r < rows; r++) out.push(l2normalize(data.subarray(r * dims, (r + 1) * dims)));
    return out;
  }

  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const { tokenizer, model } = await this.loadText();
    const padding = this.textPadding();
    // SigLIP was trained on 64-token, max-length-padded text; some exports
    // (e.g. SigLIP 2) do not declare model_max_length, so it is explicit here.
    const inputs = tokenizer(texts, padding === "max_length" ? { padding, truncation: true, max_length: 64 } : { padding, truncation: true });
    const output = await model(inputs);
    return this.toVectors(output[this.textOutput()]);
  }
}

/** SigLIP / CLIP image-text encoders. */
export class TransformersVisualProvider extends TransformersDualEncoder implements VisualEmbeddingProvider {
  protected readonly mediaTower = "vision_model";
  private get siglip(): boolean {
    return this.spec.family === "siglip";
  }
  protected override textPadding(): "max_length" | true {
    return this.siglip ? "max_length" : true;
  }
  protected textOutput() {
    return this.siglip ? "pooler_output" : "text_embeds";
  }
  protected mediaOutput() {
    return this.siglip ? "pooler_output" : "image_embeds";
  }
  protected textModelClass(lib: Transformers) {
    return this.siglip ? lib.SiglipTextModel : lib.CLIPTextModelWithProjection;
  }
  protected mediaModelClass(lib: Transformers) {
    return this.siglip ? lib.SiglipVisionModel : lib.CLIPVisionModelWithProjection;
  }

  async embedImages(images: ImageInput[]): Promise<Float32Array[]> {
    if (images.length === 0) return [];
    const [{ processor, model }, lib] = await Promise.all([this.loadMedia(), this.loadLib()]);
    const raw = images.map(
      (img) => new lib.RawImage(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength), img.width, img.height, 3),
    );
    const output = await model(await processor(raw));
    return this.toVectors(output[this.mediaOutput()]);
  }
}

/** CLAP expects 48 kHz mono and windows of at most 10 s. */
export const CLAP_SAMPLE_RATE = 48_000;
const CLAP_WINDOW = 10 * CLAP_SAMPLE_RATE;
const CLAP_BATCH = 4;

/**
 * Fixed windows for clips longer than the model's 10 s context: start, middle
 * and end. Chosen here (not by the feature extractor, whose default for long
 * input is a *random* crop) so that indexing is deterministic.
 */
export function clapWindows(samples: Float32Array): Float32Array[] {
  if (samples.length <= CLAP_WINDOW) return [samples];
  const last = samples.length - CLAP_WINDOW;
  const starts = samples.length >= 3 * CLAP_WINDOW ? [0, Math.floor(last / 2), last] : [0, last];
  return starts.map((s) => samples.subarray(s, s + CLAP_WINDOW));
}

/** CLAP audio-text encoders (LAION). */
export class TransformersAudioProvider extends TransformersDualEncoder implements AudioEmbeddingProvider {
  protected readonly mediaTower = "audio_model";
  protected textOutput() {
    return "text_embeds";
  }
  protected mediaOutput() {
    return "audio_embeds";
  }
  protected textModelClass(lib: Transformers) {
    return lib.ClapTextModelWithProjection;
  }
  protected mediaModelClass(lib: Transformers) {
    return lib.ClapAudioModelWithProjection;
  }

  async embedAudio(clips: AudioInput[]): Promise<Float32Array[]> {
    const [{ processor, model }, lib] = await Promise.all([this.loadMedia(), this.loadLib()]);
    // Features per fixed window, then the model in small batches: ~1.7x faster
    // than one window per call on CPU (vectors agree to cosine > 0.999).
    const owners: number[] = [];
    const features: Tensor[] = [];
    for (const [c, clip] of clips.entries()) {
      for (const w of clapWindows(resampleLinear(clip.samples, clip.sampleRate, CLAP_SAMPLE_RATE))) {
        features.push((await processor(w)).input_features);
        owners.push(c);
      }
    }
    const sums: (Float32Array | undefined)[] = clips.map(() => undefined);
    for (let i = 0; i < features.length; i += CLAP_BATCH) {
      const output = await model({ input_features: lib.cat(features.slice(i, i + CLAP_BATCH), 0) });
      this.toVectors(output[this.mediaOutput()]).forEach((v, k) => {
        const owner = owners[i + k]!;
        const sum = (sums[owner] ??= new Float32Array(v.length));
        for (let d = 0; d < v.length; d++) sum[d] = sum[d]! + v[d]!;
      });
    }
    return sums.map((sum) => l2normalize(sum!));
  }
}
