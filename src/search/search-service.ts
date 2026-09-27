import { isWithinLogical } from "../core/paths.ts";
import type { AssetKind, AssetMetadata, EmbeddingChannel } from "../core/types.ts";
import type { EmbeddingProvider } from "../embeddings/types.ts";
import type { IndexStore, VectorMatrix } from "../storage/index-store.ts";
import { combine, INTENT_Z_WEIGHT, intentKinds, LEXICAL_Z_WEIGHT, lexicalScore, queryTokens, zScores } from "./ranking.ts";
import { cosineScores, topK } from "./vector.ts";

/** Per-result ranking evidence. `visual`/`audio` is the cosine in that channel's space. */
export interface RankSignals {
  visual?: number;
  audio?: number;
  lexical: number;
  /** Standard deviations of the semantic score above the kind's mean (fused search only). */
  z?: number;
  /** 1 when the query explicitly asked for this kind ("sound of ...", "... icon"); fused search only. */
  intent?: number;
}

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

/** A searchable kind and the provider whose space its vectors live in. */
export interface KindSource {
  kind: AssetKind;
  provider: EmbeddingProvider;
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function hitFor(store: IndexStore, matrix: VectorMatrix, i: number, score: number, signals: RankSignals): SearchHit | undefined {
  const record = store.getAsset(matrix.paths[i]!);
  if (!record) return undefined;
  const rounded: RankSignals = { lexical: round(signals.lexical) };
  if (signals.visual !== undefined) rounded.visual = round(signals.visual);
  if (signals.audio !== undefined) rounded.audio = round(signals.audio);
  if (signals.z !== undefined) rounded.z = round(signals.z);
  if (signals.intent !== undefined) rounded.intent = signals.intent;
  return { path: record.path, kind: record.kind, score: round(score), signals: rounded, contentHash: matrix.hashes[i]!, metadata: record.metadata };
}

/** Embeds a text query, reusing the per-index query cache (skips loading the model on repeats). */
export async function embedQuery(store: IndexStore, provider: EmbeddingProvider, query: string): Promise<{ vector: Float32Array; cached: boolean }> {
  const key = query.normalize("NFC").trim();
  const now = Date.now();
  const cached = store.getCachedQuery(provider.space.id, key, now);
  if (cached) return { vector: cached, cached: true };
  const [vector] = await provider.embedTexts([key]);
  store.putCachedQuery(provider.space.id, key, vector!, now);
  return { vector: vector!, cached: false };
}

interface KindScores {
  source: KindSource;
  matrix: VectorMatrix;
  semantic: Float32Array;
  lexical: Float32Array;
  combined: Float32Array;
  keep: (i: number) => boolean;
  cached: boolean;
  embedMs: number;
  loadMs: number;
}

async function scoreKind(store: IndexStore, source: KindSource, query: string, tokens: string[], within: string | undefined): Promise<KindScores | null> {
  let t = performance.now();
  const matrix = store.loadVectors(source.provider.space.id, source.kind);
  const loadMs = performance.now() - t;
  // An empty kind never loads its model.
  if (matrix.count === 0) return null;
  t = performance.now();
  const { vector, cached } = await embedQuery(store, source.provider, query);
  const embedMs = performance.now() - t;
  const semantic = cosineScores(matrix, vector);
  const lexical = new Float32Array(matrix.count);
  const combined = new Float32Array(matrix.count);
  for (let i = 0; i < matrix.count; i++) {
    lexical[i] = lexicalScore(tokens, matrix.paths[i]!);
    combined[i] = combine(semantic[i]!, lexical[i]!);
  }
  const keep = within !== undefined ? (i: number) => isWithinLogical(within, matrix.paths[i]!) : () => true;
  return { source, matrix, semantic, lexical, combined, keep, cached, embedMs, loadMs };
}

const channelKey = (channel: EmbeddingChannel): "visual" | "audio" => (channel === "audio" ? "audio" : "visual");

/** Text search within one kind. `score` = cosine + lexical boost (see ranking.ts). */
export async function searchByText(store: IndexStore, provider: EmbeddingProvider, query: string, filters: SearchFilters): Promise<SearchOutcome> {
  const t = performance.now();
  const scored = await scoreKind(store, { kind: filters.kind, provider }, query, queryTokens(query), filters.within);
  if (!scored) return { hits: [], candidates: 0, queryCached: false, timings: { embedMs: 0, loadMs: performance.now() - t, rankMs: 0 } };
  const r = performance.now();
  const key = channelKey(provider.space.channel);
  const hits = topK(scored.combined, filters.limit, scored.keep)
    .map((i) => hitFor(store, scored.matrix, i, scored.combined[i]!, { [key]: scored.semantic[i]!, lexical: scored.lexical[i]! }))
    .filter((h): h is SearchHit => h !== undefined);
  return {
    hits,
    candidates: scored.matrix.count,
    queryCached: scored.cached,
    timings: { embedMs: scored.embedMs, loadMs: scored.loadMs, rankMs: performance.now() - r },
  };
}

/**
 * Text search across kinds. Raw cosines from different models are not
 * comparable, so each kind's semantic scores are standardized against that
 * kind's own distribution for this query (z-score: "how exceptional is this
 * match among the assets of its own modality"), the lexical signal is added in
 * that same unit for every kind, and results merge on the sum.
 */
export async function searchAcrossKinds(
  store: IndexStore,
  sources: KindSource[],
  query: string,
  filters: { limit: number; within?: string | undefined },
): Promise<SearchOutcome> {
  const tokens = queryTokens(query);
  const scored = (await Promise.all(sources.map((s) => scoreKind(store, s, query, tokens, filters.within)))).filter((s): s is KindScores => s !== null);
  const r = performance.now();
  const wanted = intentKinds(query);
  const pool: { s: KindScores; i: number; z: number; intent: number; score: number }[] = [];
  for (const s of scored) {
    const z = zScores(s.semantic);
    const intent = wanted.includes(s.source.kind) ? 1 : 0;
    const fused = new Float32Array(z.length);
    for (let i = 0; i < z.length; i++) fused[i] = z[i]! + LEXICAL_Z_WEIGHT * s.lexical[i]! + INTENT_Z_WEIGHT * intent;
    for (const i of topK(fused, filters.limit, s.keep)) pool.push({ s, i, z: z[i]!, intent, score: fused[i]! });
  }
  pool.sort((a, b) => b.score - a.score || (a.s.matrix.paths[a.i]! < b.s.matrix.paths[b.i]! ? -1 : 1));
  const hits = pool
    .slice(0, filters.limit)
    .map(({ s, i, z, intent, score }) =>
      hitFor(store, s.matrix, i, score, { [channelKey(s.source.provider.space.channel)]: s.semantic[i]!, lexical: s.lexical[i]!, z, intent }),
    )
    .filter((h): h is SearchHit => h !== undefined);
  return {
    hits,
    candidates: scored.reduce((n, s) => n + s.matrix.count, 0),
    queryCached: scored.length > 0 && scored.every((s) => s.cached),
    timings: {
      embedMs: scored.reduce((n, s) => n + s.embedMs, 0),
      loadMs: scored.reduce((n, s) => n + s.loadMs, 0),
      rankMs: performance.now() - r,
    },
  };
}

export function searchByVector(
  store: IndexStore,
  spaceId: string,
  channel: EmbeddingChannel,
  vector: Float32Array,
  filters: SearchFilters & { excludePath?: string | undefined },
): SearchOutcome {
  let t = performance.now();
  const matrix = store.loadVectors(spaceId, filters.kind);
  const loadMs = performance.now() - t;
  t = performance.now();
  const scores = cosineScores(matrix, vector);
  const within = filters.within;
  const key = channelKey(channel);
  const idx = topK(scores, filters.limit, (i) => {
    const p = matrix.paths[i]!;
    if (filters.excludePath !== undefined && p === filters.excludePath) return false;
    return within === undefined || isWithinLogical(within, p);
  });
  const hits = idx.map((i) => hitFor(store, matrix, i, scores[i]!, { [key]: scores[i]!, lexical: 0 })).filter((h): h is SearchHit => h !== undefined);
  return { hits, candidates: matrix.count, queryCached: false, timings: { embedMs: 0, loadMs, rankMs: performance.now() - t } };
}
