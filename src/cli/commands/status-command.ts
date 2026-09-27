import fs from "node:fs";
import { discoverFiles } from "../../core/discovery.ts";
import { createIgnoreMatcher } from "../../core/ignore.ts";
import { extensionOf, isWithinLogical } from "../../core/paths.ts";
import { resolveExistingProject, type Project } from "../../core/project.ts";
import { JSON_SCHEMA_VERSION, type StatusOutput } from "../../contracts/json.ts";
import { createVisualProvider } from "../../embeddings/registry.ts";
import { createProcessorRegistry, unavailableProcessors } from "../../processors/registry.ts";
import { IndexStore } from "../../storage/index-store.ts";
import { displayRoot, modelInfo } from "../context.ts";
import type { Output } from "../io.ts";

type Staleness = NonNullable<StatusOutput["staleness"]>;

/** Compares the filesystem against the index using stat only (no hashing, no model). */
async function checkStaleness(project: Project, store: IndexStore, roots: string[], spaceId: string): Promise<Staleness> {
  const registry = createProcessorRegistry(project.config);
  const { files } = await discoverFiles({
    projectRoot: project.root,
    roots,
    ignore: createIgnoreMatcher(project.root, project.config),
    accept: (l) => registry.mayHandle(extensionOf(l)),
  });
  const onDisk = new Map(files.filter((f) => registry.forFile(f)).map((f) => [f.logicalPath, f]));
  const result: Staleness = { added: 0, modified: 0, removed: 0, missingEmbeddings: 0, outdatedProcessor: 0 };
  const known = new Set<string>();
  for (const a of store.listAssetStats()) {
    if (!roots.some((r) => isWithinLogical(r, a.path))) continue;
    known.add(a.path);
    const f = onDisk.get(a.path);
    if (!f) result.removed++;
    else if (f.size !== a.size || f.modifiedAtMs !== a.mtimeMs) result.modified++;
    else {
      const p = registry.byId(a.processorId);
      if (!p || p.version !== a.processorVersion) result.outdatedProcessor++;
    }
  }
  for (const p of onDisk.keys()) if (!known.has(p)) result.added++;
  result.missingEmbeddings = store.countMissingEmbeddings(spaceId, "image");
  return result;
}

export async function statusCommand(out: Output, args: { checkStale: boolean }): Promise<number> {
  const { io } = out;
  const project = resolveExistingProject({ cwd: io.cwd, projectFlag: out.flags.project, env: io.env });
  const registry = project ? createProcessorRegistry(project.config) : null;

  if (!project || !fs.existsSync(project.dbPath)) {
    const doc: StatusOutput = {
      schemaVersion: JSON_SCHEMA_VERSION,
      command: "status",
      indexed: false,
      root: project ? displayRoot(project, io.cwd) : null,
      indexDir: null,
      roots: [],
      assets: 0,
      types: {},
      failed: 0,
      failures: [],
      processors: registry ? registry.list().map((p) => ({ id: p.id, version: p.version, enabled: true })) : [],
      unavailableProcessors: project ? unavailableProcessors(project.config) : [],
      model: null,
      indexVersion: null,
      stale: null,
      staleness: null,
      lastIndexedAt: null,
    };
    out.result(doc, () => "No asset index found here. Run `assetd index <directory>` from the project root.");
    return 0;
  }

  const store = IndexStore.open(project.dbPath, { create: false });
  try {
    const provider = createVisualProvider(project.config, { env: io.env });
    const roots = store.listRoots();
    const types = store.countByKind();
    const states = store.countByState();
    const staleness = args.checkStale ? await checkStaleness(project, store, roots, provider.space.id) : null;
    const stale = staleness ? Object.values(staleness).some((n) => n > 0) : null;
    const indexDir = displayRoot({ ...project, root: project.indexDir }, io.cwd);
    const doc: StatusOutput = {
      schemaVersion: JSON_SCHEMA_VERSION,
      command: "status",
      indexed: true,
      root: displayRoot(project, io.cwd),
      indexDir,
      roots: roots.map((r) => r || "."),
      assets: Object.values(types).reduce((a, b) => a + b, 0),
      types,
      failed: states.failed ?? 0,
      failures: store.listFailed(50),
      processors: registry!.list().map((p) => ({ id: p.id, version: p.version, enabled: true })),
      unavailableProcessors: unavailableProcessors(project.config),
      model: { ...modelInfo(project, provider), cached: await provider.isCached() },
      indexVersion: store.schemaVersion,
      stale,
      staleness,
      lastIndexedAt: store.getMeta("lastIndexedAt") ?? null,
    };
    out.result(doc, () => {
      const lines = [
        `Index:      ${doc.indexDir}  (schema v${doc.indexVersion})`,
        `Root:       ${doc.root}`,
        `Roots:      ${doc.roots.join(", ") || "-"}`,
        `Assets:     ${doc.assets}  ${Object.entries(types).map(([k, v]) => `${k}=${v}`).join(" ")}`,
        `Failed:     ${doc.failed}`,
        `Model:      ${doc.model!.model} [${doc.model!.dtype}]  ${doc.model!.cached ? "cached" : "not downloaded yet"}`,
        `Processors: ${doc.processors.map((p) => `${p.id}@${p.version}`).join(", ") || "-"}`,
        `Last run:   ${doc.lastIndexedAt ?? "-"}`,
      ];
      if (staleness) {
        lines.push(
          stale
            ? `Stale:      yes (added ${staleness.added}, modified ${staleness.modified}, removed ${staleness.removed}, missing vectors ${staleness.missingEmbeddings}, outdated ${staleness.outdatedProcessor}); run \`assetd index\``
            : "Stale:      no",
        );
      }
      for (const f of doc.failures.slice(0, 10)) lines.push(`  failed: ${f.path}: ${f.error}`);
      return lines.join("\n");
    });
    return 0;
  } finally {
    store.close();
  }
}
