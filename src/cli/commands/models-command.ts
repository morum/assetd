import { AssetdError } from "../../core/errors.ts";
import { openProject, resolveExistingProject } from "../../core/project.ts";
import { JSON_SCHEMA_VERSION, type ModelsOutput } from "../../contracts/json.ts";
import { isOffline, resolveModelCacheDir } from "../../embeddings/model-cache.ts";
import { modelInfo, providerFor } from "../context.ts";
import type { Output } from "../io.ts";

/** `assetd models status|pull`: inspect or pre-download weights (for offline use). */
export async function modelsCommand(out: Output, args: { action: string }): Promise<number> {
  const { io } = out;
  if (args.action !== "status" && args.action !== "pull") {
    throw new AssetdError("USAGE_ERROR", `Unknown models action "${args.action}". Use "status" or "pull".`);
  }
  const project = resolveExistingProject({ cwd: io.cwd, projectFlag: out.flags.project, env: io.env }) ?? openProject(io.cwd, io.env);
  const provider = providerFor(project, out);
  if (args.action === "pull") {
    await provider.prepare({ text: true, vision: true });
    // A tiny embedding confirms the weights actually run on this machine.
    await provider.embedTexts(["test"]);
  }
  const doc: ModelsOutput = {
    schemaVersion: JSON_SCHEMA_VERSION,
    command: "models",
    action: args.action,
    cacheDir: resolveModelCacheDir(io.env),
    offline: isOffline(io.env),
    model: { ...modelInfo(project, provider), cached: await provider.isCached() },
  };
  out.result(doc, () =>
    [`Model:     ${doc.model.model} [${doc.model.dtype}]`, `Cached:    ${doc.model.cached ? "yes" : "no"}`, `Cache dir: ${doc.cacheDir}`, `Offline:   ${doc.offline ? "yes" : "no"}`].join("\n"),
  );
  return 0;
}
