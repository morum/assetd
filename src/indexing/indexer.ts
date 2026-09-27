import fs from "node:fs/promises";
import { discoverFiles, type DiscoveryIssue } from "../core/discovery.ts";
import { errorMessage } from "../core/errors.ts";
import { hashBuffer } from "../core/fs-utils.ts";
import type { IgnoreMatcher } from "../core/ignore.ts";
import { extensionOf, isWithinLogical } from "../core/paths.ts";
import type { AssetRecord, FileInfo } from "../core/types.ts";
import type { VisualEmbeddingProvider } from "../embeddings/types.ts";
import type { ProcessorRegistry } from "../processors/registry.ts";
import type { AssetProcessor, EmbeddingRequest } from "../processors/types.ts";
import type { IndexStore } from "../storage/index-store.ts";

export interface IndexProgress {
  phase: "discover" | "process";
  done: number;
  total: number;
  path?: string;
}

export interface IndexRunOptions {
  projectRoot: string;
  /** Logical roots to scan ("" = whole project). */
  roots: string[];
  store: IndexStore;
  registry: ProcessorRegistry;
  visual: VisualEmbeddingProvider;
  ignore: IgnoreMatcher;
  maxFileSizeBytes: number;
  /** Re-attempt files that failed before even if they did not change. */
  retryFailed?: boolean;
  batchSize?: number;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: IndexProgress) => void;
  now?: () => number;
}

export interface IndexFailure {
  path: string;
  error: string;
}

export interface IndexStats {
  roots: string[];
  /** Files seen under the roots (after ignore rules), supported or not. */
  discovered: number;
  /** Files handled by an enabled processor. */
  supported: number;
  indexed: number;
  unchanged: number;
  removed: number;
  failed: number;
  /** Vectors reused from identical content instead of re-embedding. */
  reusedEmbeddings: number;
  interrupted: boolean;
  elapsedMs: number;
  failures: IndexFailure[];
  discoveryIssues: DiscoveryIssue[];
}

interface Prepared {
  file: FileInfo;
  processor: AssetProcessor;
  record?: AssetRecord;
  request?: EmbeddingRequest;
  /** Unchanged content: only stat info needs refreshing. */
  touchOnly?: boolean;
  /** Disappeared between discovery and reading: treated as removed. */
  vanished?: boolean;
  reused?: boolean;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function inputVersion(p: AssetProcessor): string {
  return `${p.id}@${p.version}`;
}

/**
 * Incremental indexer. Change detection is (size, mtime) first, then content
 * hash, so touching a file without changing it costs one hash. Every file is
 * isolated: a failure is recorded on that asset and the run continues. Each
 * batch commits in its own transaction, so an interrupted run keeps all
 * finished work and the next run resumes where it stopped.
 */
export async function runIndex(opts: IndexRunOptions): Promise<IndexStats> {
  const now = opts.now ?? Date.now;
  const started = now();
  const { store, registry, visual } = opts;
  const batchSize = opts.batchSize ?? 16;
  const concurrency = opts.concurrency ?? 4;
  const spaceId = visual.space.id;
  const stats: IndexStats = {
    roots: opts.roots.map((r) => r || "."),
    discovered: 0,
    supported: 0,
    indexed: 0,
    unchanged: 0,
    removed: 0,
    failed: 0,
    reusedEmbeddings: 0,
    interrupted: false,
    elapsedMs: 0,
    failures: [],
    discoveryIssues: [],
  };

  opts.onProgress?.({ phase: "discover", done: 0, total: 0 });
  const discovery = await discoverFiles({
    projectRoot: opts.projectRoot,
    roots: opts.roots,
    ignore: opts.ignore,
    accept: (logical) => registry.mayHandle(extensionOf(logical)),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  stats.discovered = discovery.seen;
  stats.discoveryIssues = discovery.issues;
  if (opts.signal?.aborted) {
    stats.interrupted = true;
    stats.elapsedMs = now() - started;
    return stats;
  }

  // Record the roots up front so that `assetd index` (no arguments) after an
  // interrupted run resumes the same scope.
  store.transaction(() => {
    for (const r of opts.roots) store.addRoot(r, now());
  });

  const files = discovery.files.filter((f) => registry.forFile(f));
  stats.supported = files.length;
  const existing = new Map(store.listAssetStats().map((a) => [a.path, a]));
  const found = new Set(files.map((f) => f.logicalPath));

  // Stale entries: gone from disk, or now ignored/unsupported. Never remove
  // anything below a directory that could not be read this run.
  const unreadable = discovery.issues.map((i) => (i.path === "." ? "" : i.path));
  const toRemove = [...existing.keys()].filter(
    (p) => opts.roots.some((r) => isWithinLogical(r, p)) && !found.has(p) && !unreadable.some((u) => isWithinLogical(u, p)),
  );

  const work: { file: FileInfo; processor: AssetProcessor }[] = [];
  for (const file of files) {
    const processor = registry.forFile(file)!;
    const prev = existing.get(file.logicalPath);
    const statSame = prev !== undefined && prev.size === file.size && prev.mtimeMs === file.modifiedAtMs;
    const versionSame = prev !== undefined && prev.processorId === processor.id && prev.processorVersion === processor.version;
    if (prev && statSame && versionSame) {
      if (prev.state === "failed" && !opts.retryFailed) {
        stats.unchanged++;
        continue;
      }
      if (prev.state === "indexed" && store.hasEmbedding(prev.contentHash, spaceId, inputVersion(processor))) {
        stats.unchanged++;
        continue;
      }
    }
    work.push({ file, processor });
  }

  const failRecord = (file: FileInfo, processor: AssetProcessor, error: string, contentHash = ""): AssetRecord => ({
    path: file.logicalPath,
    kind: processor.kind,
    extension: file.extension,
    size: file.size,
    modifiedAtMs: file.modifiedAtMs,
    contentHash,
    metadata: {},
    processorId: processor.id,
    processorVersion: processor.version,
    state: "failed",
    error,
    indexedAtMs: now(),
  });

  const prepare = async ({ file, processor }: { file: FileInfo; processor: AssetProcessor }): Promise<Prepared> => {
    if (file.size > opts.maxFileSizeBytes) {
      return { file, processor, record: failRecord(file, processor, `File is larger than the ${Math.round(opts.maxFileSizeBytes / 1048576)} MB limit`) };
    }
    let data: Buffer;
    try {
      // Read once: the same buffer feeds hashing and decoding, and no handle stays open (Windows locks).
      data = await fs.readFile(file.nativePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { file, processor, vanished: true };
      return { file, processor, record: failRecord(file, processor, `Cannot read file: ${errorMessage(err)}`) };
    }
    const contentHash = hashBuffer(data);
    const current = { ...file, size: data.byteLength };
    const prev = existing.get(file.logicalPath);
    const iv = inputVersion(processor);
    const embedded = store.hasEmbedding(contentHash, spaceId, iv);
    if (
      prev &&
      prev.contentHash === contentHash &&
      prev.state === "indexed" &&
      prev.processorId === processor.id &&
      prev.processorVersion === processor.version &&
      embedded
    ) {
      return { file: current, processor, touchOnly: true };
    }
    try {
      const base = {
        path: file.logicalPath,
        kind: processor.kind,
        extension: file.extension,
        size: current.size,
        modifiedAtMs: file.modifiedAtMs,
        contentHash,
        processorId: processor.id,
        processorVersion: processor.version,
        state: "indexed" as const,
        indexedAtMs: now(),
      };
      if (embedded) {
        const metadata = await processor.extractMetadata({ file: current, data });
        return { file: current, processor, record: { ...base, metadata }, reused: true };
      }
      const processed = await processor.process({ file: current, data });
      const record: AssetRecord = { ...base, kind: processed.kind, metadata: processed.metadata };
      if (processed.description !== undefined) record.description = processed.description;
      if (processed.tags !== undefined) record.tags = processed.tags;
      const request = processed.embeddingRequests.find((r) => r.channel === "visual");
      return request ? { file: current, processor, record, request } : { file: current, processor, record };
    } catch (err) {
      return { file: current, processor, record: failRecord(file, processor, `Processing failed: ${errorMessage(err)}`, contentHash) };
    }
  };

  const embedBatch = async (items: Prepared[]): Promise<void> => {
    const pending = items.filter((p) => p.request);
    if (pending.length === 0) return;
    const vectors = new Map<Prepared, Float32Array>();
    try {
      const out = await visual.embedImages(pending.map((p) => p.request!.input.image));
      pending.forEach((p, i) => vectors.set(p, out[i]!));
    } catch (batchErr) {
      // Isolate the offending file(s): retry one by one.
      for (const p of pending) {
        try {
          const [v] = await visual.embedImages([p.request!.input.image]);
          vectors.set(p, v!);
        } catch (err) {
          const message = errorMessage(err ?? batchErr);
          if ((err as { code?: string }).code === "MODEL_UNAVAILABLE") throw err;
          p.record = failRecord(p.file, p.processor, `Embedding failed: ${message}`, p.record?.contentHash ?? "");
        }
      }
    }
    const t = now();
    store.transaction(() => {
      for (const [p, v] of vectors) store.putEmbedding(p.record!.contentHash, spaceId, inputVersion(p.processor), v, t);
    });
    for (const p of pending) delete p.request; // release pixel buffers early
  };

  let done = 0;
  for (let i = 0; i < work.length; i += batchSize) {
    if (opts.signal?.aborted) {
      stats.interrupted = true;
      break;
    }
    const batch = work.slice(i, i + batchSize);
    const prepared = await mapLimit(batch, concurrency, prepare);
    await embedBatch(prepared);
    store.transaction(() => {
      for (const p of prepared) {
        if (p.touchOnly) {
          store.touchAsset(p.file.logicalPath, p.file.size, p.file.modifiedAtMs);
          stats.unchanged++;
          continue;
        }
        if (p.vanished) {
          if (existing.has(p.file.logicalPath)) {
            store.deleteAsset(p.file.logicalPath);
            stats.removed++;
          }
          continue;
        }
        const record = p.record!;
        store.upsertAsset(record);
        if (record.state === "failed") {
          stats.failed++;
          stats.failures.push({ path: record.path, error: record.error ?? "unknown error" });
        } else {
          stats.indexed++;
          if (p.reused) stats.reusedEmbeddings++;
        }
      }
    });
    done += batch.length;
    opts.onProgress?.({ phase: "process", done, total: work.length, path: batch[batch.length - 1]!.file.logicalPath });
  }

  if (!stats.interrupted) {
    const t = now();
    store.transaction(() => {
      for (const p of toRemove) store.deleteAsset(p);
      store.pruneOrphanEmbeddings();
      store.setMeta("lastIndexedAt", new Date(t).toISOString());
      store.setMeta("visualSpace", spaceId);
    });
    stats.removed += toRemove.length;
  }
  stats.elapsedMs = now() - started;
  return stats;
}
