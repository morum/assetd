import type { AssetMetadata, FileInfo } from "../../core/types.ts";
import type { AssetProcessor, FileContent, ProcessedAsset } from "../types.ts";
import { loadGltf } from "./gltf-loader.ts";
import { describeScene, type ModelScene } from "./model-scene.ts";
import { loadObj } from "./obj-loader.ts";

export const MODEL3D_EXTENSIONS = ["glb", "gltf", "obj"] as const;

export function loadModelScene(content: FileContent): Promise<ModelScene> {
  return content.file.extension === "obj" ? loadObj(content.file.nativePath, content.data) : loadGltf(content.file.nativePath, content.data);
}

/**
 * 3D models (glTF 2.0 binary/JSON with Draco/meshopt, Wavefront OBJ+MTL).
 * The source file is only read. Metadata comes from the parsed scene.
 */
export class Model3DProcessor implements AssetProcessor {
  readonly id = "model3d";
  readonly version: string = "1";
  readonly kind = "model3d" as const;
  readonly channels = [] as const;
  readonly extensions = MODEL3D_EXTENSIONS;

  supports(file: FileInfo): boolean {
    return (MODEL3D_EXTENSIONS as readonly string[]).includes(file.extension);
  }

  async extractMetadata(content: FileContent): Promise<AssetMetadata> {
    return describeScene(await loadModelScene(content));
  }

  async process(content: FileContent): Promise<ProcessedAsset> {
    return { kind: "model3d", metadata: describeScene(await loadModelScene(content)), embeddingRequests: [] };
  }
}
