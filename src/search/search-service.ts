import { isWithinLogical } from "../core/paths.ts";
import type { AssetKind, AssetMetadata } from "../core/types.ts";
import type { VisualEmbeddingProvider } from "../embeddings/types.ts";
import type { IndexStore } from "../storage/index-store.ts";
import { combine, lexicalScore, queryTokens, type RankSignals } from "./ranking.ts";
import { cosineScores, topK } from "./vector.ts";

export interface SearchHit {
  path: string;
  kind: AssetKind;
  score: number;
  signals: RankSignals;
  contentHash: string;
  metadata: AssetMetadata;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** Number of assets scored. */
  candidates: number;
  timings: { embedMs: number; loadMs: number; rankMs: number };
  queryCached: boolean;
}

export interface SearchFilters {
  kind: AssetKind;
  limit: number;
  /** Only assets under this logical directory. */
  within?: string | undefined;
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function materialize(store: IndexStore, paths: string[], hashes: string[], idx: number[], signals: (i: number) => RankSignals, score: (i: number) => number): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const i of idx) {
    const record = store.getAsset(paths[i]!);
    if (!record) continue;
    const s = signals(i);
    hits.push({
      path: record.path,
      kind: record.kind,
      score: round(score(i)),
      signals: { visual: round(s.visual), lexical: round(s.lexical) },
      contentHash: hashes[i]!,
      metadata: record.metadata,
    });
  }
  return hits;
}

/** Embeds a text query, reusing the per-index query cache (skips loading the model on repeats). */
export async function embedQuery(store: IndexStore, provider: VisualEmbeddingProvider, query: string): Promise<{ vector: Float32Array; cached: boolean }> {
  const key = query.normalize("NFC").trim();
  const now = Date.now();
  const cached = store.getCachedQuery(provider.space.id, key, now);
  if (cached) return { vector: cached, cached: true };
  const [vector] = await provider.embedTexts([key]);
  store.putCachedQuery(provider.space.id, key, vector!, now);
  return { vector: vector!, cached: false };
}

export async function searchByText(store: IndexStore, provider: VisualEmbeddingProvider, query: string, filters: SearchFilters): Promise<SearchOutcome> {
  let t = performance.now();
  const { vector, cached } = await embedQuery(store, provider, query);
  const embedMs = performance.now() - t;
  t = performance.now();
  const matrix = store.loadVectors(provider.space.id, filters.kind);
  const loadMs = performance.now() - t;
  t = performance.now();
  const visual = cosineScores(matrix, vector);
  const tokens = queryTokens(query);
  const lexical = new Float32Array(matrix.count);
  const combined = new Float32Array(matrix.count);
  for (let i = 0; i < matrix.count; i++) {
    lexical[i] = lexicalScore(tokens, matrix.paths[i]!);
    combined[i] = combine({ visual: visual[i]!, lexical: lexical[i]! });
  }
  const within = filters.within;
  const keep = within !== undefined ? (i: number) => isWithinLogical(within, matrix.paths[i]!) : undefined;
  const idx = topK(combined, filters.limit, keep);
  const hits = materialize(store, matrix.paths, matrix.hashes, idx, (i) => ({ visual: visual[i]!, lexical: lexical[i]! }), (i) => combined[i]!);
  return { hits, candidates: matrix.count, queryCached: cached, timings: { embedMs, loadMs, rankMs: performance.now() - t } };
}

export function searchByVector(
  store: IndexStore,
  spaceId: string,
  vector: Float32Array,
  filters: SearchFilters & { excludePath?: string | undefined },
): SearchOutcome {
  let t = performance.now();
  const matrix = store.loadVectors(spaceId, filters.kind);
  const loadMs = performance.now() - t;
  t = performance.now();
  const visual = cosineScores(matrix, vector);
  const within = filters.within;
  const idx = topK(visual, filters.limit, (i) => {
    const p = matrix.paths[i]!;
    if (filters.excludePath !== undefined && p === filters.excludePath) return false;
    return within === undefined || isWithinLogical(within, p);
  });
  const hits = materialize(store, matrix.paths, matrix.hashes, idx, (i) => ({ visual: visual[i]!, lexical: 0 }), (i) => visual[i]!);
  return { hits, candidates: matrix.count, queryCached: false, timings: { embedMs: 0, loadMs, rankMs: performance.now() - t } };
}
