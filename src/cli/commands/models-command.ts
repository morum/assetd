import { AssetdError } from "../../core/errors.ts";
import { openProject, resolveExistingProject } from "../../core/project.ts";
import { JSON_SCHEMA_VERSION, type ModelsOutput } from "../../contracts/json.ts";
import { isOffline, resolveModelCacheDir } from "../../embeddings/model-cache.ts";
import { modelInfo, providerList, providersFor } from "../context.ts";
import type { Output } from "../io.ts";

/** `assetd models status|pull`: inspect or pre-download weights (for offline use). */
export async function modelsCommand(out: Output, args: { action: string }): Promise<number> {
  const { io } = out;
  if (args.action !== "status" && args.action !== "pull") {
    throw new AssetdError("USAGE_ERROR", `Unknown models action "${args.action}". Use "status" or "pull".`);
  }
  const project = resolveExistingProject({ cwd: io.cwd, projectFlag: out.flags.project, env: io.env }) ?? openProject(io.cwd, io.env);
  const providers = providerList(providersFor(project, out));
  if (args.action === "pull") {
    for (const provider of providers) {
      await provider.prepare({ text: true, media: true });
      // A tiny embedding confirms the weights actually run on this machine.
      await provider.embedTexts(["test"]);
    }
  }
  const models = await Promise.all(providers.map(async (p) => ({ ...modelInfo(project, p), cached: await p.isCached() })));
  const doc: ModelsOutput = {
    schemaVersion: JSON_SCHEMA_VERSION,
    command: "models",
    action: args.action,
    cacheDir: resolveModelCacheDir(io.env),
    offline: isOffline(io.env),
    model: models[0]!,
    models,
  };
  out.result(doc, () =>
    [
      ...models.map((m) => `${(m.channel ?? "").padEnd(7)} ${m.model} [${m.dtype}]  ${m.cached ? "cached" : "not downloaded"}`),
      `Cache dir: ${doc.cacheDir}`,
      `Offline:   ${doc.offline ? "yes" : "no"}`,
    ].join("\n"),
  );
  return 0;
}
