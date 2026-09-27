import { AssetdError } from "../../core/errors.ts";
import { normalizeLogicalInput, toLogicalPath } from "../../core/paths.ts";
import { requireIndexedProject, type Project } from "../../core/project.ts";
import type { AssetKind, AssetMetadata } from "../../core/types.ts";
import { JSON_SCHEMA_VERSION, type SearchOutput } from "../../contracts/json.ts";
import { RANKING_ID } from "../../search/ranking.ts";
import { searchByText } from "../../search/search-service.ts";
import { IndexStore } from "../../storage/index-store.ts";
import { modelInfo, providerFor } from "../context.ts";
import type { Output } from "../io.ts";
import path from "node:path";

export interface SearchArgs {
  query: string;
  kind: AssetKind;
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

export function describeMetadata(m: AssetMetadata): string {
  const parts: string[] = [];
  if (typeof m.width === "number" && typeof m.height === "number") parts.push(`${m.width}x${m.height}`);
  if (typeof m.format === "string") parts.push(m.format);
  if (m.hasTransparency === true) parts.push("alpha");
  if (m.animated === true) parts.push(`${String(m.frames)} frames`);
  return parts.join(" ");
}

export async function searchCommand(out: Output, args: SearchArgs): Promise<number> {
  const started = performance.now();
  const { io } = out;
  if (args.query.trim() === "") throw new AssetdError("USAGE_ERROR", "Search query is empty");
  if (args.kind !== "image") throw new AssetdError("USAGE_ERROR", `Searching "${args.kind}" assets is not supported yet; only "image" is indexed.`);
  const project = requireIndexedProject({ cwd: io.cwd, projectFlag: out.flags.project, env: io.env });
  const within = resolveWithin(project, io.cwd, args.within);
  const store = IndexStore.open(project.dbPath, { create: false });
  try {
    const provider = providerFor(project, out);
    const outcome = await searchByText(store, provider, args.query, { kind: args.kind, limit: args.limit, within });
    const doc: SearchOutput = {
      schemaVersion: JSON_SCHEMA_VERSION,
      command: "search",
      query: args.query,
      type: args.kind,
      limit: args.limit,
      within: within ?? null,
      ranking: RANKING_ID,
      model: modelInfo(project, provider),
      candidates: outcome.candidates,
      results: outcome.hits.map((h, i) => ({ rank: i + 1, path: h.path, kind: h.kind, score: h.score, signals: h.signals, metadata: h.metadata })),
      timings: {
        totalMs: Math.round(performance.now() - started),
        embedMs: Math.round(outcome.timings.embedMs),
        searchMs: Math.round(outcome.timings.loadMs + outcome.timings.rankMs),
        queryCached: outcome.queryCached,
      },
    };
    if (outcome.candidates === 0) out.warn("the index has no searchable images for the current model; run `assetd index`");
    out.result(doc, () =>
      doc.results.length === 0 ? "No results." : doc.results.map((r) => `${r.score.toFixed(3)}  ${r.path}  ${describeMetadata(r.metadata)}`.trimEnd()).join("\n"),
    );
    return 0;
  } finally {
    store.close();
  }
}
