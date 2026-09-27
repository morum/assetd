import fs from "node:fs";
import path from "node:path";
import { AssetdError, errorMessage } from "../core/errors.ts";
import type { EmbeddingSpace } from "../core/types.ts";
import { isOffline, resolveModelCacheDir } from "./model-cache.ts";
import { spaceIdFor, type VisualModelSpec } from "./presets.ts";
import { l2normalize, type ImageInput, type ProviderLoadEvent, type VisualEmbeddingProvider } from "./types.ts";

type Transformers = typeof import("@huggingface/transformers");
type Tensor = import("@huggingface/transformers").Tensor;

export interface TransformersProviderOptions {
  env?: NodeJS.ProcessEnv;
  onProgress?: (event: ProviderLoadEvent) => void;
}

const DTYPE_SUFFIX = { q8: "_quantized", fp16: "_fp16", fp32: "" } as const;

/**
 * SigLIP / CLIP dual encoders running on ONNX Runtime (CPU) through
 * transformers.js. Pure Node.js: no Python, no CUDA, same code path on Windows
 * and Linux. Text and vision towers load independently, so a text query never
 * pays for loading the vision weights.
 */
export class TransformersVisualProvider implements VisualEmbeddingProvider {
  readonly space: EmbeddingSpace;
  private readonly spec: VisualModelSpec;
  private readonly env: NodeJS.ProcessEnv;
  private readonly onProgress: ((e: ProviderLoadEvent) => void) | undefined;
  private lib?: Promise<Transformers>;
  /** Files absent from the cache when loading began: only these are real downloads. */
  private downloading = new Set<string>();
  private text?: Promise<{ tokenizer: any; model: any }>;
  private vision?: Promise<{ processor: any; model: any }>;

  constructor(spec: VisualModelSpec, options: TransformersProviderOptions = {}) {
    this.spec = spec;
    this.env = options.env ?? process.env;
    this.onProgress = options.onProgress;
    this.space = {
      id: spaceIdFor(spec),
      channel: "visual",
      provider: spec.family,
      model: spec.repo,
      dimensions: spec.dimensions,
    };
  }

  get cacheDir(): string {
    return resolveModelCacheDir(this.env);
  }

  requiredFiles(part: "text" | "vision"): string[] {
    const suffix = DTYPE_SUFFIX[this.spec.dtype];
    return part === "text"
      ? ["config.json", "tokenizer.json", "tokenizer_config.json", `onnx/text_model${suffix}.onnx`]
      : ["config.json", "preprocessor_config.json", `onnx/vision_model${suffix}.onnx`];
  }

  private missingFiles(): Set<string> {
    const base = path.join(this.cacheDir, ...this.spec.repo.split("/"));
    const files = [...this.requiredFiles("text"), ...this.requiredFiles("vision")];
    return new Set(files.filter((f) => !fs.existsSync(path.join(base, ...f.split("/")))));
  }

  async isCached(): Promise<boolean> {
    return this.missingFiles().size === 0;
  }

  private loadLib(): Promise<Transformers> {
    this.lib ??= import("@huggingface/transformers").then((lib) => {
      this.downloading = this.missingFiles();
      lib.env.cacheDir = this.cacheDir;
      lib.env.allowLocalModels = false;
      lib.env.allowRemoteModels = !isOffline(this.env);
      return lib;
    });
    return this.lib;
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

  private loadText() {
    this.text ??= this.wrapLoad(
      "text encoder",
      this.loadLib().then(async (lib) => {
        const opts = { progress_callback: this.progress };
        const tokenizer = await lib.AutoTokenizer.from_pretrained(this.spec.repo, opts);
        const Model = this.spec.family === "siglip" ? lib.SiglipTextModel : lib.CLIPTextModelWithProjection;
        const model = await Model.from_pretrained(this.spec.repo, { ...opts, dtype: this.spec.dtype, device: "cpu", session_options: this.sessionOptions() });
        return { tokenizer, model };
      }),
    );
    return this.text;
  }

  private loadVision() {
    this.vision ??= this.wrapLoad(
      "vision encoder",
      this.loadLib().then(async (lib) => {
        const opts = { progress_callback: this.progress };
        const processor = await lib.AutoProcessor.from_pretrained(this.spec.repo, opts);
        const Model = this.spec.family === "siglip" ? lib.SiglipVisionModel : lib.CLIPVisionModelWithProjection;
        const model = await Model.from_pretrained(this.spec.repo, { ...opts, dtype: this.spec.dtype, device: "cpu", session_options: this.sessionOptions() });
        return { processor, model };
      }),
    );
    return this.vision;
  }

  async prepare(parts: { text?: boolean; vision?: boolean } = { text: true, vision: true }): Promise<void> {
    await Promise.all([parts.text ? this.loadText() : null, parts.vision ? this.loadVision() : null]);
  }

  private toVectors(tensor: Tensor): Float32Array[] {
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
    const inputs =
      this.spec.family === "siglip"
        ? tokenizer(texts, { padding: "max_length", truncation: true })
        : tokenizer(texts, { padding: true, truncation: true });
    const output = await model(inputs);
    return this.toVectors(this.spec.family === "siglip" ? output.pooler_output : output.text_embeds);
  }

  async embedImages(images: ImageInput[]): Promise<Float32Array[]> {
    if (images.length === 0) return [];
    const [{ processor, model }, lib] = await Promise.all([this.loadVision(), this.loadLib()]);
    const raw = images.map((img) => new lib.RawImage(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength), img.width, img.height, 3));
    const inputs = await processor(raw);
    const output = await model(inputs);
    return this.toVectors(this.spec.family === "siglip" ? output.pooler_output : output.image_embeds);
  }
}
