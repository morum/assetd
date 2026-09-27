import fs from "node:fs/promises";
import { AssetdError } from "../../core/errors.ts";
import { hashBuffer } from "../../core/fs-utils.ts";
import { extensionOf } from "../../core/paths.ts";
import { requireIndexedProject } from "../../core/project.ts";
import { JSON_SCHEMA_VERSION, type InspectOutput } from "../../contracts/json.ts";
import { channelOfSpace } from "../../embeddings/presets.ts";
import { createProviders, providerForChannel } from "../../embeddings/registry.ts";
import { createProcessorRegistry } from "../../processors/registry.ts";
import { IndexStore } from "../../storage/index-store.ts";
import { resolveAssetInput } from "../context.ts";
import type { Output } from "../io.ts";

function formatSize(n: number | null): string {
  if (n === null) return "-";
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export async function inspectCommand(out: Output, args: { path: string }): Promise<number> {
  const { io } = out;
  const project = requireIndexedProject({ cwd: io.cwd, projectFlag: out.flags.project, env: io.env });
  const store = IndexStore.open(project.dbPath, { create: false });
  try {
    const ref = resolveAssetInput(project, io.cwd, args.path, store);
    if (ref.logical === null) throw new AssetdError("PATH_NOT_FOUND", `${args.path} is outside the project root`, { path: args.path });
    const record = store.getAsset(ref.logical);
    if (!record && !ref.exists) throw new AssetdError("PATH_NOT_FOUND", `File not found: ${args.path}`, { path: args.path });

    const providers = createProviders(project.config, { env: io.env });
    const registry = createProcessorRegistry(project.config);
    let stat: { size: number; mtimeMs: number } | null = null;
    if (ref.exists) {
      const st = await fs.stat(ref.native);
      stat = { size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
    }
    const extension = extensionOf(ref.logical);
    const file = { logicalPath: ref.logical, nativePath: ref.native, extension, size: stat?.size ?? 0, modifiedAtMs: stat?.mtimeMs ?? 0 };
    const processor = registry.forFile(file);

    const doc: InspectOutput = {
      schemaVersion: JSON_SCHEMA_VERSION,
      command: "inspect",
      path: ref.logical,
      exists: ref.exists,
      state: "not-indexed",
      kind: record?.kind ?? processor?.kind ?? null,
      extension,
      size: stat?.size ?? record?.size ?? null,
      modifiedAt: stat ? new Date(stat.mtimeMs).toISOString() : record ? new Date(record.modifiedAtMs).toISOString() : null,
      contentHash: record?.contentHash || null,
      metadata: record?.metadata ?? {},
      description: record?.description ?? null,
      tags: record?.tags ?? [],
      processor: record ? { id: record.processorId, version: record.processorVersion } : processor ? { id: processor.id, version: processor.version } : null,
      embeddings: [],
      previews: [],
      indexedAt: record ? new Date(record.indexedAtMs).toISOString() : null,
      error: record?.error ?? null,
      otherMatches: [],
    };

    if (record) {
      doc.embeddings = store.embeddingsFor(record.contentHash).map((e) => {
        const channel = channelOfSpace(e.spaceId);
        const active = providerForChannel(providers, channel)?.space.id;
        return {
          channel,
          space: e.spaceId,
          dimensions: e.dims,
          current: e.spaceId === active && e.inputVersion === `${record.processorId}@${record.processorVersion}`,
        };
      });
      if (!ref.exists) doc.state = "missing";
      else if (record.state === "failed") doc.state = "failed";
      else if (stat && (stat.size !== record.size || stat.mtimeMs !== record.modifiedAtMs)) doc.state = "stale";
      else if (processor && processor.version !== record.processorVersion) doc.state = "stale";
      else if (!doc.embeddings.some((e) => e.current)) doc.state = "stale";
      else doc.state = "indexed";
    } else if (!processor) {
      doc.state = "unsupported";
      doc.kind = null;
    } else {
      // Present on disk but not in the index yet: extract metadata live (cheap, no model).
      try {
        const data = await fs.readFile(ref.native);
        doc.contentHash = hashBuffer(data);
        doc.metadata = await processor.extractMetadata({ file, data });
      } catch (err) {
        doc.error = (err as Error).message;
      }
    }
    doc.otherMatches = store
      .findAssetsByMatchKey(ref.logical)
      .map((r) => r.path)
      .filter((p) => p !== ref.logical);

    out.result(doc, () => {
      const lines = [
        `Path:       ${doc.path}`,
        `State:      ${doc.state}${doc.error ? ` (${doc.error})` : ""}`,
        `Kind:       ${doc.kind ?? "-"}  (.${doc.extension || "?"})`,
        `Size:       ${formatSize(doc.size)}`,
        `Modified:   ${doc.modifiedAt ?? "-"}`,
      ];
      const m = doc.metadata;
      if (typeof m.width === "number") lines.push(`Dimensions: ${m.width}x${String(m.height)} (${String(m.aspect)})`);
      if (m.format) lines.push(`Format:     ${String(m.format)}`);
      if ("hasTransparency" in m) lines.push(`Alpha:      ${m.hasTransparency ? "transparent pixels" : m.hasAlphaChannel ? "alpha channel, fully opaque" : "none"}`);
      if (m.dominantColor) lines.push(`Dominant:   ${String(m.dominantColor)}`);
      if (m.animated) lines.push(`Frames:     ${String(m.frames)}`);
      if (typeof m.durationSeconds === "number") {
        lines.push(`Duration:   ${m.durationSeconds.toFixed(3)} s`);
        lines.push(`Audio:      ${String(m.channels)} ch, ${String(m.sampleRate)} Hz, ~${String(m.bitrateKbps)} kbps`);
        lines.push(`Levels:     peak ${m.peakDb ?? "-∞"} dBFS, RMS ${m.rmsDb ?? "-∞"} dBFS`);
      }
      if (doc.processor) lines.push(`Processor:  ${doc.processor.id}@${doc.processor.version}`);
      for (const e of doc.embeddings) lines.push(`Embedding:  ${e.space} (${e.dimensions}d)${e.current ? "" : " [not current]"}`);
      if (doc.indexedAt) lines.push(`Indexed at: ${doc.indexedAt}`);
      if (doc.contentHash) lines.push(`SHA-256:    ${doc.contentHash}`);
      if (doc.otherMatches.length) lines.push(`Also:       ${doc.otherMatches.join(", ")} (differs only in case)`);
      return lines.join("\n");
    });
    return 0;
  } finally {
    store.close();
  }
}
