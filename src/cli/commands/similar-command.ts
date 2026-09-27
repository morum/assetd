import fs from "node:fs/promises";
import { AssetdError } from "../../core/errors.ts";
import { hashBuffer } from "../../core/fs-utils.ts";
import { extensionOf } from "../../core/paths.ts";
import { requireIndexedProject } from "../../core/project.ts";
import type { AssetKind } from "../../core/types.ts";
import { JSON_SCHEMA_VERSION, type SimilarOutput } from "../../contracts/json.ts";
import { createProcessorRegistry } from "../../processors/registry.ts";
import { searchByVector } from "../../search/search-service.ts";
import { IndexStore } from "../../storage/index-store.ts";
import { displayPath, modelInfo, providerFor, resolveAssetInput } from "../context.ts";
import type { Output } from "../io.ts";
import { describeMetadata, resolveWithin } from "./search-command.ts";

export interface SimilarArgs {
  path: string;
  kind: AssetKind;
  limit: number;
  within: string | undefined;
}

export async function similarCommand(out: Output, args: SimilarArgs): Promise<number> {
  const started = performance.now();
  const { io } = out;
  if (args.kind !== "image") throw new AssetdError("USAGE_ERROR", `Similarity for "${args.kind}" assets is not supported yet.`);
  const project = requireIndexedProject({ cwd: io.cwd, projectFlag: out.flags.project, env: io.env });
  const within = resolveWithin(project, io.cwd, args.within);
  const store = IndexStore.open(project.dbPath, { create: false });
  try {
    const provider = providerFor(project, out);
    const ref = resolveAssetInput(project, io.cwd, args.path, store);
    const record = ref.logical !== null ? store.getAsset(ref.logical) : undefined;
    let vector: Float32Array | undefined;
    let refHash: string | undefined;
    let indexed = false;
    if (record && record.state === "indexed") {
      const stored = store.getEmbedding(record.contentHash, provider.space.id);
      if (stored) {
        vector = stored.vector;
        refHash = record.contentHash;
        indexed = true;
      }
    }
    if (!vector) {
      // Not indexed (new file, or a reference image outside the project): embed it now.
      if (!ref.exists) throw new AssetdError("PATH_NOT_FOUND", `File not found: ${args.path}`, { path: args.path });
      const registry = createProcessorRegistry(project.config);
      const size = (await fs.stat(ref.native)).size;
      const file = { logicalPath: ref.logical ?? ref.native, nativePath: ref.native, extension: extensionOf(ref.native.replace(/\\/g, "/")), size, modifiedAtMs: 0 };
      const processor = registry.forFile(file);
      if (!processor || !processor.channels.includes("visual")) {
        throw new AssetdError("NOT_INDEXED", `Unsupported file type for similarity: ${args.path}`, { path: args.path });
      }
      const data = await fs.readFile(ref.native);
      refHash = hashBuffer(data);
      let processed;
      try {
        processed = await processor.process({ file, data });
      } catch (err) {
        throw new AssetdError("NOT_INDEXED", `Cannot decode ${args.path}: ${(err as Error).message}`, { path: args.path });
      }
      const request = processed.embeddingRequests.find((r) => r.channel === "visual");
      if (!request) throw new AssetdError("NOT_INDEXED", `No visual representation for ${args.path}`);
      [vector] = await provider.embedImages([request.input.image]);
    }
    const outcome = searchByVector(store, provider.space.id, vector!, {
      kind: args.kind,
      limit: args.limit,
      within,
      excludePath: ref.logical ?? undefined,
    });
    const doc: SimilarOutput = {
      schemaVersion: JSON_SCHEMA_VERSION,
      command: "similar",
      reference: { path: ref.logical ?? displayPath(project, ref.native), indexed },
      type: args.kind,
      limit: args.limit,
      within: within ?? null,
      model: modelInfo(project, provider),
      candidates: outcome.candidates,
      results: outcome.hits.map((h, i) => ({
        rank: i + 1,
        path: h.path,
        kind: h.kind,
        score: h.score,
        signals: h.signals,
        metadata: h.metadata,
        duplicate: h.contentHash === refHash,
      })),
      timings: { totalMs: Math.round(performance.now() - started) },
    };
    out.result(doc, () =>
      doc.results.length === 0
        ? "No results."
        : doc.results.map((r) => `${r.score.toFixed(3)}  ${r.path}  ${describeMetadata(r.metadata)}${r.duplicate ? "  (identical file)" : ""}`.trimEnd()).join("\n"),
    );
    return 0;
  } finally {
    store.close();
  }
}
