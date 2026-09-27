import sharp from "sharp";
import type { AssetMetadata, FileInfo } from "../../core/types.ts";
import type { AssetProcessor, FileContent, ProcessedAsset } from "../types.ts";

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "tif", "tiff", "avif", "svg"] as const;

/** Images smaller than this are upscaled with nearest-neighbour (keeps pixel art crisp). */
const MIN_EMBED_SIZE = 224;
/** Larger images are downscaled before handing them to the provider. */
const MAX_EMBED_SIZE = 512;

sharp.cache(false); // one-shot CLI: no benefit, and it keeps memory flat on big runs

function toHex(c: { r: number; g: number; b: number }): string {
  return "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export async function extractImageMetadata(data: Buffer): Promise<AssetMetadata> {
  const image = sharp(data, { animated: false });
  const meta = await image.metadata();
  const width = meta.autoOrient?.width ?? meta.width;
  const height = meta.autoOrient?.height ?? meta.height;
  if (!width || !height) throw new Error("Image has no dimensions");
  const stats = await image.stats();
  const divisor = gcd(width, height);
  const result: AssetMetadata = {
    width,
    height,
    aspectRatio: Math.round((width / height) * 10_000) / 10_000,
    aspect: `${width / divisor}:${height / divisor}`,
    format: meta.format,
    hasAlphaChannel: meta.hasAlpha === true,
    hasTransparency: meta.hasAlpha === true && !stats.isOpaque,
    dominantColor: toHex(stats.dominant),
    channels: meta.channels,
    colorSpace: meta.space,
  };
  if (meta.pages && meta.pages > 1) {
    result.frames = meta.pages;
    result.animated = true;
  }
  if (meta.density) result.density = meta.density;
  return result;
}

/** Decodes to RGB for embedding: alpha flattened on white, resized into a sane range. */
export async function decodeForEmbedding(data: Buffer): Promise<{ data: Uint8Array; width: number; height: number }> {
  const base = sharp(data, { animated: false }).autoOrient();
  const meta = await base.metadata();
  const w = meta.autoOrient?.width ?? meta.width ?? 0;
  const h = meta.autoOrient?.height ?? meta.height ?? 0;
  const longest = Math.max(w, h);
  let pipeline = base.flatten({ background: "#ffffff" });
  if (longest > 0 && longest < MIN_EMBED_SIZE) {
    const scale = Math.ceil(MIN_EMBED_SIZE / longest);
    pipeline = pipeline.resize(w * scale, h * scale, { kernel: "nearest" });
  } else if (longest > MAX_EMBED_SIZE) {
    pipeline = pipeline.resize(MAX_EMBED_SIZE, MAX_EMBED_SIZE, { fit: "inside" });
  }
  const { data: raw, info } = await pipeline.removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), width: info.width, height: info.height };
}

export class ImageProcessor implements AssetProcessor {
  readonly id = "image";
  readonly version: string = "1";
  readonly kind = "image" as const;
  readonly channels = ["visual"] as const;
  readonly extensions = IMAGE_EXTENSIONS;

  supports(file: FileInfo): boolean {
    return (IMAGE_EXTENSIONS as readonly string[]).includes(file.extension);
  }

  extractMetadata(content: FileContent): Promise<AssetMetadata> {
    return extractImageMetadata(content.data);
  }

  async process(content: FileContent): Promise<ProcessedAsset> {
    const metadata = await extractImageMetadata(content.data);
    const image = await decodeForEmbedding(content.data);
    return {
      kind: "image",
      metadata,
      embeddingRequests: [{ channel: "visual", input: { type: "image", image } }],
    };
  }
}
