import path from "node:path";
import { AssetdError } from "../../core/errors.ts";
import { normalizeLogicalInput, toLogicalPath } from "../../core/paths.ts";
import { requireIndexedProject, type Project } from "../../core/project.ts";
import type { AssetKind, AssetMetadata } from "../../core/types.ts";
import { JSON_SCHEMA_VERSION, type SearchOutput } from "../../contracts/json.ts";
import type { Providers } from "../../embeddings/types.ts";
import type { AssetdConfig } from "../../core/config.ts";
import { FUSED_RANKING_ID, rankingId } from "../../search/ranking.ts";
import { searchAcrossKinds, searchByText, type KindSource } from "../../search/search-service.ts";
import { IndexStore } from "../../storage/index-store.ts";
import { modelInfo, providersFor } from "../context.ts";
import type { Output } from "../io.ts";

export interface SearchArgs {
  query: string;
  /** Undefined: every indexed kind. */
  kind: AssetKind | undefined;
  limit: number;
  within: string | undefined;
}

/** Resolves --in: a directory relative to the cwd, or a logical project path. */
export function resolveWithin(project: Project, cwd: string, within: string | undefined): string | undefined {
  if (within === undefined) return undefined;
  const fromCwd = toLogicalPath(project.root, path.resolve(cwd, within));
  const logical = fromCwd ?? normalizeLogicalInput(within);
  if (logical === null) throw new AssetdError("USAGE_ERROR", `--in ${within} is outside the project`);
  return logical;
}

/** Searchable kinds and the provider of each one's space. */
export function kindSources(providers: Providers, config: AssetdConfig): KindSource[] {
  const sources: KindSource[] = [];
  if (config.processors.image) sources.push({ kind: "image", provider: providers.visual });
  if (providers.audio) sources.push({ kind: "audio", provider: providers.audio });
  // 3D models are embedded through renders, in the same visual space as images.
  if (config.processors.model3d) sources.push({ kind: "model3d", provider: providers.visual });
  return sources;
}

export function requireSource(sources: KindSource[], kind: AssetKind): KindSource {
  const source = sources.find((s) => s.kind === kind);
  if (!source) {
    const available = sources.map((s) => s.kind).join(", ");
    throw new AssetdError("USAGE_ERROR", `Searching "${kind}" assets is not available (enabled: ${available}).`);
  }
  return source;
}

export function describeMetadata(m: AssetMetadata): string {
  const parts: string[] = [];
  if (typeof m.width === "number" && typeof m.height === "number") parts.push(`${m.width}x${m.height}`);
  if (typeof m.durationSeconds === "number") parts.push(`${m.durationSeconds.toFixed(2)}s`);
  if (typeof m.triangleCount === "number") parts.push(`${m.triangleCount} tris`);
  if (m.hasAnimations === true) parts.push("animated");
  if (typeof m.format === "string") parts.push(m.format);
  if (m.hasTransparency === true) parts.push("alpha");
  if (m.animated === true) parts.push(`${String(m.frames)} frames`);
  return parts.join(" ");
}

export async function searchCommand(out: Output, args: SearchArgs): Promise<number> {
  const started = performance.now();
  const { io } = out;
  if (args.query.trim() === "") throw new AssetdError("USAGE_ERROR", "Search query is empty");
  const project = requireIndexedProject({ cwd: io.cwd, projectFlag: out.flags.project, env: io.env });
  const within = resolveWithin(project, io.cwd, args.within);
  const store = IndexStore.open(project.dbPath, { create: false });
  try {
    const providers = providersFor(project, out);
    const sources = kindSources(providers, project.config);
    if (sources.length === 0) throw new AssetdError("USAGE_ERROR", "No searchable asset kind is enabled in assetd.json.");
    if (args.kind) requireSource(sources, args.kind);
    // Without --type, fuse only when more than one kind actually has assets;
    // an image-only project gets exactly the single-kind ranking.
    const counts = store.countByKind();
    const populated = sources.filter((s) => (counts[s.kind] ?? 0) > 0);
    const single = args.kind ? requireSource(sources, args.kind) : populated.length === 1 ? populated[0]! : populated.length === 0 ? sources[0]! : undefined;

    const outcome = single
      ? await searchByText(store, single.provider, args.query, { kind: single.kind, limit: args.limit, within })
      : await searchAcrossKinds(store, populated, args.query, { limit: args.limit, within });
    const used = single ? [single] : populated;
    const primary = single ?? populated[0]!;
    const doc: SearchOutput = {
      schemaVersion: JSON_SCHEMA_VERSION,
      command: "search",
      query: args.query,
      type: single ? single.kind : "all",
      limit: args.limit,
      within: within ?? null,
      ranking: single ? rankingId(single.provider.space.channel === "audio" ? "audio" : "visual") : FUSED_RANKING_ID,
      model: modelInfo(project, primary.provider),
      // Kinds can share a space (images and 3D renders both use the visual model): list each model once.
      models: [...new Map(used.map((s) => [s.provider.space.id, modelInfo(project, s.provider)])).values()],
      candidates: outcome.candidates,
      results: outcome.hits.map((h, i) => ({ rank: i + 1, path: h.path, kind: h.kind, score: h.score, signals: h.signals, metadata: h.metadata })),
      timings: {
        totalMs: Math.round(performance.now() - started),
        embedMs: Math.round(outcome.timings.embedMs),
        searchMs: Math.round(outcome.timings.loadMs + outcome.timings.rankMs),
        queryCached: outcome.queryCached,
      },
    };
    if (outcome.candidates === 0) out.warn("the index has no searchable assets of this type for the current model; run `assetd index`");
    out.result(doc, () =>
      doc.results.length === 0
        ? "No results."
        : doc.results
            .map((r) => `${r.score.toFixed(3)}  ${doc.type === "all" ? `${r.kind.padEnd(7)}  ` : ""}${r.path}  ${describeMetadata(r.metadata)}`.trimEnd())
            .join("\n"),
    );
    return 0;
  } finally {
    store.close();
  }
}
