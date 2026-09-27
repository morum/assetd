import { pathTokens } from "../core/paths.ts";

/**
 * Ranking v1 (single modality).
 *
 *   score = visual + LEXICAL_WEIGHT * lexical
 *
 * `visual` is the cosine similarity between the query and the image in the
 * visual model's joint space. `lexical` is the fraction of meaningful query
 * words that appear in the asset's path (filenames are often informative in
 * game projects, and a path hit is strong evidence). The weight keeps visual
 * similarity dominant.
 *
 * When more modalities land, their raw cosine scores will NOT be summed or
 * compared directly: each channel ranks its own candidates and results are
 * merged with reciprocal-rank fusion. Signals are exposed per result so
 * callers can see why something ranked where it did.
 */
export const RANKING_ID = "visual+lexical/v1";
export const LEXICAL_WEIGHT = 0.05;

const STOPWORDS = new Set([
  "a", "an", "the", "of", "for", "and", "or", "with", "to", "in", "on", "that", "this", "is", "are", "looks", "like",
  "some", "any", "find", "image", "picture", "asset", "assets", "file",
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

export interface RankSignals {
  visual: number;
  lexical: number;
}

export function combine(signals: RankSignals): number {
  return signals.visual + LEXICAL_WEIGHT * signals.lexical;
}
