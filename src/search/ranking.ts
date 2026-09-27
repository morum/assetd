import { pathTokens } from "../core/paths.ts";

/**
 * Ranking.
 *
 * Within one kind ("--type image", "--type audio"):
 *
 *   score = semantic + LEXICAL_WEIGHT * lexical
 *
 * `semantic` is the cosine similarity between the query and the asset in the
 * kind's own joint text–media space (SigLIP for images, CLAP for audio).
 * `lexical` is the fraction of meaningful query words that appear in the
 * asset's path (filenames are often informative in game projects). The weight
 * keeps semantic similarity dominant.
 *
 * Across kinds (no --type): cosines from different models live on different
 * scales and are never compared. Each kind's semantic scores are standardized
 * over all candidates of that kind for this query (z-score), and the lexical
 * signal is added in the same unit for every kind:
 *
 *   fused = z(semantic) + LEXICAL_Z_WEIGHT * lexical + INTENT_Z_WEIGHT * intent
 *
 * (A fixed cosine bonus would not do: 0.05 is ~2.5 standard deviations of
 * SigLIP scores but ~0.6 for CLAP, so filenames would favour images.)
 */
/** Single-kind ranking id, e.g. "visual+lexical/v1" (unchanged since v0.1 for images). */
export function rankingId(channel: "visual" | "audio"): string {
  return `${channel}+lexical/v1`;
}
export const FUSED_RANKING_ID = "zscore-fusion/v2";
export const LEXICAL_Z_WEIGHT = 1;

/**
 * Explicit words that say which kind the user wants ("the sound of coins",
 * "a sword icon"). A matching kind gets INTENT_Z_WEIGHT extra standard
 * deviations in fused search; `--type` remains the precise way to choose.
 */
export const INTENT_Z_WEIGHT = 4;
const INTENT_WORDS: Record<string, readonly string[]> = {
  audio: ["sound", "sounds", "sfx", "audio", "music", "song", "track", "ambience", "ambient", "noise", "voice", "jingle"],
  image: ["icon", "icons", "sprite", "sprites", "image", "images", "picture", "texture", "textures", "tile", "tiles", "illustration", "portrait"],
};

/** Kinds the query explicitly asks for (empty when it names none, or several). */
export function intentKinds(query: string): string[] {
  const words = new Set(pathTokens(query));
  const kinds = Object.keys(INTENT_WORDS).filter((k) => INTENT_WORDS[k]!.some((w) => words.has(w)));
  return kinds.length === 1 ? kinds : [];
}
export const LEXICAL_WEIGHT = 0.05;

const STOPWORDS = new Set([
  "a", "an", "the", "of", "for", "and", "or", "with", "to", "in", "on", "that", "this", "is", "are", "looks", "like",
  "some", "any", "find", "image", "picture", "asset", "assets", "file", "sound", "audio",
]);

export function queryTokens(query: string): string[] {
  return [...new Set(pathTokens(query).filter((t) => t.length >= 2 && !STOPWORDS.has(t)))];
}

/** Fraction of query tokens found in the path (prefix match handles plurals: "sword" ~ "swords"). */
export function lexicalScore(tokens: string[], logicalPath: string): number {
  if (tokens.length === 0) return 0;
  const words = pathTokens(logicalPath);
  let hits = 0;
  for (const t of tokens) {
    if (words.some((w) => w === t || (t.length >= 3 && (w.startsWith(t) || t.startsWith(w)) && Math.min(w.length, t.length) >= 3))) hits++;
  }
  return hits / tokens.length;
}

export function combine(semantic: number, lexical: number): number {
  return semantic + LEXICAL_WEIGHT * lexical;
}

/**
 * Standard scores; a degenerate distribution (one asset, all equal) yields zeros.
 * With few candidates the sample z is unreliable (two assets always give ±1),
 * so it is shrunk by n / (n + SHRINK_N): a kind needs a real population before
 * its matches can outrank another kind's.
 */
export const SHRINK_N = 10;

export function zScores(values: Float32Array): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  if (n < 2) return out;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += values[i]!;
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (values[i]! - mean) ** 2;
  const sd = Math.sqrt(variance / n);
  if (sd < 1e-9) return out;
  const shrink = n / (n + SHRINK_N);
  for (let i = 0; i < n; i++) out[i] = ((values[i]! - mean) / sd) * shrink;
  return out;
}
