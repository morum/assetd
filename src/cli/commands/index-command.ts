import fs from "node:fs";
import path from "node:path";
import { AssetdError, ExitCode } from "../../core/errors.ts";
import { createIgnoreMatcher } from "../../core/ignore.ts";
import { normalizeLogicalInput, toLogicalPath } from "../../core/paths.ts";
import { resolveExistingProject, resolveProjectForIndex, type Project } from "../../core/project.ts";
import { JSON_SCHEMA_VERSION, type IndexOutput } from "../../contracts/json.ts";
import { runIndex } from "../../indexing/indexer.ts";
import { createProcessorRegistry, unavailableProcessors } from "../../processors/registry.ts";
import { IndexStore } from "../../storage/index-store.ts";
import { acquireIndexLock } from "../../storage/lock.ts";
import { displayRoot, modelInfo, providerFor } from "../context.ts";
import type { Output } from "../io.ts";

export interface IndexArgs {
  targets: string[];
  retryFailed: boolean;
  strict: boolean;
}

function resolveRoots(project: Project, cwd: string, targets: string[], store: IndexStore | null): string[] {
  if (targets.length > 0) {
    return targets.map((t) => {
      const abs = path.resolve(cwd, t);
      const logical = toLogicalPath(project.root, abs);
      if (logical === null) throw new AssetdError("USAGE_ERROR", `${t} is outside the project root ${project.root}`);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        throw new AssetdError("PATH_NOT_FOUND", `Directory not found: ${t}`, { path: t });
      }
      if (!st.isDirectory()) throw new AssetdError("USAGE_ERROR", `Not a directory: ${t}`, { path: t });
      return logical;
    });
  }
  const recorded = store?.listRoots() ?? [];
  if (recorded.length > 0) return recorded;
  if (project.config.roots && project.config.roots.length > 0) {
    return project.config.roots.map((r) => {
      const logical = normalizeLogicalInput(r);
      if (logical === null) throw new AssetdError("USAGE_ERROR", `Invalid root in assetd.json: ${r}`);
      return logical;
    });
  }
  return [""];
}

export async function indexCommand(out: Output, args: IndexArgs): Promise<number> {
  const { io } = out;
  const base = { cwd: io.cwd, projectFlag: out.flags.project, env: io.env };
  const project =
    args.targets.length > 0
      ? resolveProjectForIndex({ ...base, targets: args.targets })
      : (resolveExistingProject(base) ?? resolveProjectForIndex({ ...base, targets: ["."] }));

  const release = acquireIndexLock(project.indexDir);
  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts > 1) process.exit(ExitCode.INTERRUPTED);
    out.clearProgress();
    out.info("Interrupt received: finishing the current batch (press Ctrl+C again to abort now)...");
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  const store = IndexStore.open(project.dbPath, { create: true });
  try {
    const roots = resolveRoots(project, io.cwd, args.targets, store);
    const registry = createProcessorRegistry(project.config);
    const warnings = unavailableProcessors(project.config).map((p) => `processor "${p}" is not available in this version and was skipped`);
    for (const w of warnings) out.warn(w);
    const visual = providerFor(project, out);
    const ignore = createIgnoreMatcher(project.root, project.config);
    const stats = await runIndex({
      projectRoot: project.root,
      roots,
      store,
      registry,
      visual,
      ignore,
      maxFileSizeBytes: project.config.maxFileSizeMb * 1048576,
      retryFailed: args.retryFailed,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === "discover") out.progress("Discovering files...");
        else out.progress(`[${p.done}/${p.total}] ${p.path ?? ""}`);
      },
    });
    out.clearProgress();
    for (const issue of stats.discoveryIssues) warnings.push(`cannot read ${issue.path}: ${issue.error}`);

    const doc: IndexOutput = {
      schemaVersion: JSON_SCHEMA_VERSION,
      command: "index",
      root: displayRoot(project, io.cwd),
      roots: stats.roots,
      model: modelInfo(project, visual),
      discovered: stats.discovered,
      supported: stats.supported,
      indexed: stats.indexed,
      unchanged: stats.unchanged,
      removed: stats.removed,
      failed: stats.failed,
      reusedEmbeddings: stats.reusedEmbeddings,
      interrupted: stats.interrupted,
      elapsedMs: Math.round(stats.elapsedMs),
      failures: stats.failures,
      warnings,
    };
    out.result(doc, () => {
      const w = String(Math.max(stats.discovered, 1)).length + 1;
      const n = (v: number) => v.toLocaleString("en-US").padStart(w + 2);
      const lines = [
        `Discovered: ${n(stats.discovered)} files (${stats.supported.toLocaleString("en-US")} supported)`,
        `Indexed:    ${n(stats.indexed)}`,
        `Unchanged:  ${n(stats.unchanged)}`,
        `Removed:    ${n(stats.removed)}`,
        `Failed:     ${n(stats.failed)}`,
      ];
      for (const f of stats.failures.slice(0, 20)) lines.push(`  ${f.path}: ${f.error}`);
      if (stats.failures.length > 20) lines.push(`  ... and ${stats.failures.length - 20} more (see \`assetd status --json\`)`);
      lines.push(`Root: ${doc.root}  Roots: ${stats.roots.join(", ")}  (${(stats.elapsedMs / 1000).toFixed(1)}s)`);
      if (stats.interrupted) lines.push("Interrupted: finished work was saved; run the same command again to resume.");
      return lines.join("\n");
    });
    if (stats.interrupted) return ExitCode.INTERRUPTED;
    if (args.strict && stats.failed > 0) return ExitCode.PARTIAL_FAILURE;
    return ExitCode.OK;
  } finally {
    process.off("SIGINT", onSigint);
    store.close();
    release();
  }
}
