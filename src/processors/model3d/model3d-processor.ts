import sharp from "sharp";
import type { AssetMetadata, FileInfo } from "../../core/types.ts";
import type { ImageInput } from "../../embeddings/types.ts";
import { renderViews, VIEWS, type View } from "../../render/rasterizer.ts";
import type { AssetProcessor, FileContent, ProcessedAsset } from "../types.ts";
import { loadGltf } from "./gltf-loader.ts";
import { describeScene, type ModelScene } from "./model-scene.ts";
import { loadObj } from "./obj-loader.ts";

export const MODEL3D_EXTENSIONS = ["glb", "gltf", "obj"] as const;

/**
 * Views embedded per model (vectors averaged), by count. On 709 CC0 models,
 * Hit@5 was 90% / 92% / 95% for 1 / 2 / 4 views at 12.9 / 5.5 / 2.8 models/s
 * (docs/evaluation.md). 2 opposite perspectives are the default.
 */
export const EMBED_VIEW_SETS: Record<1 | 2 | 4, View[]> = {
  1: [VIEWS.perspective1!],
  2: [VIEWS.perspective1!, VIEWS.perspective2!],
  4: [VIEWS.perspective1!, VIEWS.perspective2!, VIEWS.perspective3!, VIEWS.perspective4!],
};
export const DEFAULT_EMBED_VIEWS: View[] = EMBED_VIEW_SETS[2];
const RENDER_SIZE = 256;
export const PREVIEW_NAME = "preview";

export function loadModelScene(content: FileContent): Promise<ModelScene> {
  return content.file.extension === "obj" ? loadObj(content.file.nativePath, content.data) : loadGltf(content.file.nativePath, content.data);
}

export interface Model3DOptions {
  views?: View[];
}

/**
 * 3D models (glTF 2.0 binary/JSON with Draco/meshopt, Wavefront OBJ+MTL).
 * The source file is only read. Each model is rendered in software from a few
 * standard viewpoints; the renders are embedded in the visual (SigLIP) space,
 * so models are searchable by text and comparable with images. The first view
 * is kept as the asset's preview.
 */
export class Model3DProcessor implements AssetProcessor {
  readonly id = "model3d";
  /** Includes the view set: changing it re-embeds every model. */
  readonly version: string;
  readonly kind = "model3d" as const;
  readonly channels = ["visual"] as const;
  readonly extensions = MODEL3D_EXTENSIONS;
  private readonly views: View[];

  constructor(options: Model3DOptions = {}) {
    this.views = options.views ?? DEFAULT_EMBED_VIEWS;
    this.version = `2+${this.views.map((v) => v.name).join(",")}`;
  }

  supports(file: FileInfo): boolean {
    return (MODEL3D_EXTENSIONS as readonly string[]).includes(file.extension);
  }

  async extractMetadata(content: FileContent): Promise<AssetMetadata> {
    return describeScene(await loadModelScene(content));
  }

  async process(content: FileContent): Promise<ProcessedAsset> {
    const scene = await loadModelScene(content);
    const metadata = describeScene(scene);
    if (scene.triangleCount === 0) throw new Error("Model has no triangles to render");
    const renders = await renderViews(scene, this.views, { size: RENDER_SIZE });
    const images: ImageInput[] = renders.map((r) => ({ data: r.rgb, width: r.size, height: r.size }));
    const hero = renders[0]!;
    const png = await sharp(Buffer.from(hero.rgb), { raw: { width: hero.size, height: hero.size, channels: 3 } }).png().toBuffer();
    return {
      kind: "model3d",
      metadata,
      embeddingRequests: [{ channel: "visual", input: { type: "views", images } }],
      previews: [{ name: PREVIEW_NAME, png }],
    };
  }
}
