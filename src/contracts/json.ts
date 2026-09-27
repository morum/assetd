import { z } from "zod";
import { ASSET_KINDS } from "../core/types.ts";

/**
 * Stable JSON contracts for `--json` output. Compatible releases may ADD
 * optional fields; renaming/removing fields or changing their meaning bumps
 * JSON_SCHEMA_VERSION. Every document carries `schemaVersion` and `command`.
 */
export const JSON_SCHEMA_VERSION = 1;

const kind = z.enum(ASSET_KINDS);
const envelope = <C extends string>(command: C) => ({
  schemaVersion: z.literal(JSON_SCHEMA_VERSION),
  command: z.literal(command),
});

export const modelInfoSchema = z.object({
  space: z.string(),
  provider: z.string(),
  model: z.string(),
  dtype: z.string().optional(),
  dimensions: z.number().int().nullable(),
});

export const searchResultSchema = z.object({
  rank: z.number().int().positive(),
  path: z.string(),
  kind,
  score: z.number(),
  signals: z.object({ visual: z.number(), lexical: z.number() }),
  metadata: z.record(z.string(), z.unknown()),
});

export const searchOutputSchema = z.object({
  ...envelope("search"),
  query: z.string(),
  type: kind,
  limit: z.number().int(),
  within: z.string().nullable(),
  ranking: z.string(),
  model: modelInfoSchema,
  candidates: z.number().int(),
  results: z.array(searchResultSchema),
  timings: z.object({ totalMs: z.number(), embedMs: z.number(), searchMs: z.number(), queryCached: z.boolean() }),
});

export const similarOutputSchema = z.object({
  ...envelope("similar"),
  reference: z.object({ path: z.string(), indexed: z.boolean() }),
  type: kind,
  limit: z.number().int(),
  within: z.string().nullable(),
  model: modelInfoSchema,
  candidates: z.number().int(),
  results: z.array(searchResultSchema.extend({ duplicate: z.boolean() })),
  timings: z.object({ totalMs: z.number() }),
});

export const indexOutputSchema = z.object({
  ...envelope("index"),
  root: z.string(),
  roots: z.array(z.string()),
  model: modelInfoSchema,
  discovered: z.number().int(),
  supported: z.number().int(),
  indexed: z.number().int(),
  unchanged: z.number().int(),
  removed: z.number().int(),
  failed: z.number().int(),
  reusedEmbeddings: z.number().int(),
  interrupted: z.boolean(),
  elapsedMs: z.number(),
  failures: z.array(z.object({ path: z.string(), error: z.string() })),
  warnings: z.array(z.string()),
});

export const inspectOutputSchema = z.object({
  ...envelope("inspect"),
  path: z.string(),
  exists: z.boolean(),
  state: z.enum(["indexed", "failed", "stale", "not-indexed", "unsupported", "missing"]),
  kind: kind.nullable(),
  extension: z.string(),
  size: z.number().int().nullable(),
  modifiedAt: z.string().nullable(),
  contentHash: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  processor: z.object({ id: z.string(), version: z.string() }).nullable(),
  embeddings: z.array(z.object({ channel: z.string(), space: z.string(), dimensions: z.number().int(), current: z.boolean() })),
  previews: z.array(z.string()),
  indexedAt: z.string().nullable(),
  error: z.string().nullable(),
  otherMatches: z.array(z.string()),
});

export const statusOutputSchema = z.object({
  ...envelope("status"),
  indexed: z.boolean(),
  root: z.string().nullable(),
  indexDir: z.string().nullable(),
  roots: z.array(z.string()),
  assets: z.number().int(),
  types: z.record(z.string(), z.number().int()),
  failed: z.number().int(),
  /** First failures (up to 50), for diagnosis. */
  failures: z.array(z.object({ path: z.string(), error: z.string() })),
  processors: z.array(z.object({ id: z.string(), version: z.string(), enabled: z.boolean() })),
  unavailableProcessors: z.array(z.string()),
  model: modelInfoSchema.extend({ cached: z.boolean() }).nullable(),
  indexVersion: z.number().int().nullable(),
  stale: z.boolean().nullable(),
  staleness: z
    .object({ added: z.number().int(), modified: z.number().int(), removed: z.number().int(), missingEmbeddings: z.number().int(), outdatedProcessor: z.number().int() })
    .nullable(),
  lastIndexedAt: z.string().nullable(),
});

export const contactSheetOutputSchema = z.object({
  ...envelope("contact-sheet"),
  output: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  columns: z.number().int(),
  rows: z.number().int(),
  items: z.array(z.object({ label: z.string(), path: z.string(), error: z.string().nullable() })),
});

export const modelsOutputSchema = z.object({
  ...envelope("models"),
  action: z.enum(["status", "pull"]),
  cacheDir: z.string(),
  offline: z.boolean(),
  model: modelInfoSchema.extend({ cached: z.boolean() }),
});

export const errorOutputSchema = z.object({
  schemaVersion: z.literal(JSON_SCHEMA_VERSION),
  command: z.string(),
  error: z.object({ code: z.string(), exitCode: z.number().int(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
});

export type SearchOutput = z.infer<typeof searchOutputSchema>;
export type SimilarOutput = z.infer<typeof similarOutputSchema>;
export type IndexOutput = z.infer<typeof indexOutputSchema>;
export type InspectOutput = z.infer<typeof inspectOutputSchema>;
export type StatusOutput = z.infer<typeof statusOutputSchema>;
export type ContactSheetOutput = z.infer<typeof contactSheetOutputSchema>;
export type ModelsOutput = z.infer<typeof modelsOutputSchema>;
export type ErrorOutput = z.infer<typeof errorOutputSchema>;
