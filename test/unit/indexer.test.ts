import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/core/config.ts";
import { createIgnoreMatcher } from "../../src/core/ignore.ts";
import { INDEX_DB_NAME, INDEX_DIR_NAME } from "../../src/core/project.ts";
import type { FileInfo } from "../../src/core/types.ts";
import { resolveVisualModel } from "../../src/embeddings/presets.ts";
import { TestHashProvider } from "../../src/embeddings/test-hash-provider.ts";
import { runIndex, type IndexRunOptions } from "../../src/indexing/indexer.ts";
import { ImageProcessor } from "../../src/processors/image/image-processor.ts";
import { ProcessorRegistry } from "../../src/processors/registry.ts";
import type { AssetProcessor, FileContent, ProcessedAsset } from "../../src/processors/types.ts";
import { IndexStore } from "../../src/storage/index-store.ts";
import { tempProject, writeImage, type TempProject } from "../helpers.ts";
import path from "node:path";

let project: TempProject;
let store: IndexStore | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
  project.cleanup();
});

function options(overrides: Partial<IndexRunOptions> = {}): IndexRunOptions {
  store ??= IndexStore.open(path.join(project.root, INDEX_DIR_NAME, INDEX_DB_NAME), { create: true });
  return {
    projectRoot: project.root,
    roots: [""],
    store,
    registry: new ProcessorRegistry().register(new ImageProcessor()),
    providers: { visual: new TestHashProvider(resolveVisualModel("test-hash")) },
    ignore: createIgnoreMatcher(project.root, defaultConfig()),
    maxFileSizeBytes: 10 * 1048576,
    batchSize: 2,
    ...overrides,
  };
}

async function seed(n: number) {
  for (let i = 0; i < n; i++) await writeImage(project, `a/img${i}.png`, `#${(i * 40).toString(16).padStart(2, "0")}8040`);
}

describe("indexer", () => {
  it("keeps finished batches when interrupted and resumes on the next run", async () => {
    project = tempProject();
    await seed(6);
    const controller = new AbortController();
    const first = await runIndex(
      options({
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === "process" && p.done >= 2) controller.abort();
        },
      }),
    );
    expect(first.interrupted).toBe(true);
    expect(first.indexed).toBe(2);
    expect(first.removed).toBe(0);
    expect(store!.listRoots()).toEqual([""]);
    const second = await runIndex(options());
    expect(second.interrupted).toBe(false);
    expect(second.indexed).toBe(4);
    expect(second.unchanged).toBe(2);
  });

  it("reprocesses assets when a processor version changes", async () => {
    project = tempProject();
    await seed(2);
    await runIndex(options());
    class ImageV2 extends ImageProcessor {
      override readonly version: string = "2";
    }
    const stats = await runIndex(options({ registry: new ProcessorRegistry().register(new ImageV2()) }));
    expect(stats.indexed).toBe(2);
    expect(store!.getAsset("a/img0.png")!.processorVersion).toBe("2");
  });

  it("records oversized files as failures instead of decoding them", async () => {
    project = tempProject();
    await seed(1);
    const stats = await runIndex(options({ maxFileSizeBytes: 10 }));
    expect(stats.failed).toBe(1);
    expect(stats.failures[0]!.error).toMatch(/larger than/);
  });

  it("isolates a provider failure to the offending file", async () => {
    project = tempProject();
    await seed(3);
    const visual = new TestHashProvider(resolveVisualModel("test-hash"));
    const original = visual.embedImages.bind(visual);
    let call = 0;
    visual.embedImages = async (imgs) => {
      call++;
      if (imgs.length > 1 || call === 3) throw new Error("boom");
      return original(imgs);
    };
    const stats = await runIndex(options({ providers: { visual }, batchSize: 3 }));
    expect(stats.indexed + stats.failed).toBe(3);
    expect(stats.failed).toBe(1);
    expect(stats.failures[0]!.error).toMatch(/Embedding failed: boom/);
  });

  it("accepts new processors without changes to the engine", async () => {
    project = tempProject();
    await seed(1);
    const fs = await import("node:fs");
    fs.writeFileSync(project.file("a/level.tres"), "[gd_resource]");
    // A project-specific processor that reuses the image pipeline for a custom extension.
    const custom: AssetProcessor = {
      id: "godot-texture",
      version: "1",
      kind: "image",
      channels: ["visual"],
      extensions: ["tres"],
      supports: (f: FileInfo) => f.extension === "tres",
      extractMetadata: async () => ({ engine: "godot" }),
      process: async (_c: FileContent): Promise<ProcessedAsset> => ({
        kind: "image",
        metadata: { engine: "godot" },
        embeddingRequests: [{ channel: "visual", input: { type: "image", image: { data: new Uint8Array(12).fill(200), width: 2, height: 2 } } }],
      }),
    };
    const registry = new ProcessorRegistry().register(new ImageProcessor()).register(custom);
    const stats = await runIndex(options({ registry }));
    expect(stats.indexed).toBe(2);
    expect(store!.getAsset("a/level.tres")).toMatchObject({ processorId: "godot-texture", metadata: { engine: "godot" } });
  });
});
