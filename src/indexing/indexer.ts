import fs from "node:fs/promises";
import { discoverFiles, type DiscoveryIssue } from "../core/discovery.ts";
import { errorMessage } from "../core/errors.ts";
import { hashBuffer } from "../core/fs-utils.ts";
import type { IgnoreMatcher } from "../core/ignore.ts";
import { extensionOf, isWithinLogical } from "../core/paths.ts";
import type { AssetRecord, EmbeddingChannel, FileInfo } from "../core/types.ts";
import { providerForChannel } from "../embeddings/registry.ts";
import type { Providers } from "../embeddings/types.ts";
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
  /** One provider per channel the registered processors produce. */
  providers: Providers;
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
  requests?: EmbeddingRequest[];
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
  const { store, registry, providers } = opts;
  const batchSize = opts.batchSize ?? 16;
  const concurrency = opts.concurrency ?? 4;
  const spaceOf = (channel: EmbeddingChannel): string | undefined => providerForChannel(providers, channel)?.space.id;
  /** Every channel the processor produces has a current vector for this content. */
  const complete = (contentHash: string, processor: AssetProcessor): boolean =>
    processor.channels.every((ch) => {
      const space = spaceOf(ch);
      return space !== undefined && store.hasEmbedding(contentHash, space, inputVersion(processor));
    });
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
      if (prev.state === "indexed" && complete(prev.contentHash, processor)) {
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
    // Processors without embedding channels have nothing to reuse.
    const embedded = processor.channels.length > 0 && complete(contentHash, processor);
    if (
      prev &&
      prev.contentHash === contentHash &&
      prev.state === "indexed" &&
      prev.processorId === processor.id &&
      prev.processorVersion === processor.version &&
      complete(contentHash, processor)
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
      const missing = processed.embeddingRequests.find((r) => !spaceOf(r.channel));
      if (missing) throw new Error(`No embedding provider configured for channel "${missing.channel}"`);
      return { file: current, processor, record, requests: processed.embeddingRequests };
    } catch (err) {
      return { file: current, processor, record: failRecord(file, processor, `Processing failed: ${errorMessage(err)}`, contentHash) };
    }
  };

  /** Embeds one channel's requests: one batched call, then file-by-file to isolate a failure. */
  const embedChannel = async (channel: EmbeddingChannel, items: { p: Prepared; req: EmbeddingRequest }[]) => {
    const call = (reqs: EmbeddingRequest[]): Promise<Float32Array[]> => {
      if (channel === "visual") return providers.visual.embedImages(reqs.map((r) => (r as Extract<EmbeddingRequest, { channel: "visual" }>).input.image));
      if (channel === "audio" && providers.audio) return providers.audio.embedAudio(reqs.map((r) => (r as Extract<EmbeddingRequest, { channel: "audio" }>).input.audio));
      throw new Error(`No embedding provider configured for channel "${channel}"`);
    };
    const vectors = new Map<Prepared, Float32Array>();
    try {
      const out = await call(items.map((i) => i.req));
      items.forEach((i, k) => vectors.set(i.p, out[k]!));
    } catch {
      for (const { p, req } of items) {
        try {
          const [v] = await call([req]);
          vectors.set(p, v!);
        } catch (err) {
          if ((err as { code?: string }).code === "MODEL_UNAVAILABLE") throw err;
          p.record = failRecord(p.file, p.processor, `Embedding failed: ${errorMessage(err)}`, p.record?.contentHash ?? "");
        }
      }
    }
    return vectors;
  };

  const embedBatch = async (items: Prepared[]): Promise<void> => {
    const byChannel = new Map<EmbeddingChannel, { p: Prepared; req: EmbeddingRequest }[]>();
    for (const p of items) for (const req of p.requests ?? []) byChannel.set(req.channel, [...(byChannel.get(req.channel) ?? []), { p, req }]);
    const t = now();
    for (const [channel, reqs] of byChannel) {
      const vectors = await embedChannel(channel, reqs);
      store.transaction(() => {
        for (const [p, v] of vectors) {
          if (p.record?.state === "indexed") store.putEmbedding(p.record.contentHash, spaceOf(channel)!, inputVersion(p.processor), v, t);
        }
      });
    }
    for (const p of items) delete p.requests; // release decoded pixels/samples early
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
      for (const ch of ["visual", "audio"] as const) {
        const space = spaceOf(ch);
        if (space) store.setMeta(`space:${ch}`, space);
      }
    });
    stats.removed += toRemove.length;
  }
  stats.elapsedMs = now() - started;
  return stats;
}
