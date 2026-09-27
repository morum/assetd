import path from "node:path";
import { AssetdError } from "../../core/errors.ts";
import { hashString, writeFileAtomic } from "../../core/fs-utils.ts";
import { requireIndexedProject } from "../../core/project.ts";
import { JSON_SCHEMA_VERSION, type ContactSheetOutput } from "../../contracts/json.ts";
import { renderContactSheet, type ContactSheetItem } from "../../contact-sheet/contact-sheet.ts";
import { searchByText } from "../../search/search-service.ts";
import { IndexStore } from "../../storage/index-store.ts";
import { displayPath, providerFor, resolveAssetInput } from "../context.ts";
import type { Output } from "../io.ts";
import fs from "node:fs";

export interface ContactSheetArgs {
  paths: string[];
  search: string | undefined;
  limit: number;
  out: string | undefined;
  columns: number | undefined;
  thumbSize: number;
}

const MAX_ITEMS = 100;

export async function contactSheetCommand(out: Output, args: ContactSheetArgs): Promise<number> {
  const { io } = out;
  const project = requireIndexedProject({ cwd: io.cwd, projectFlag: out.flags.project, env: io.env });
  const store = IndexStore.open(project.dbPath, { create: false });
  try {
    const entries: { display: string; native: string }[] = [];
    if (args.search !== undefined) {
      const outcome = await searchByText(store, providerFor(project, out), args.search, { kind: "image", limit: args.limit });
      for (const h of outcome.hits) entries.push({ display: h.path, native: path.join(project.root, ...h.path.split("/")) });
    }
    for (const p of args.paths) {
      const ref = resolveAssetInput(project, io.cwd, p, store);
      if (!ref.exists) throw new AssetdError("PATH_NOT_FOUND", `File not found: ${p}`, { path: p });
      entries.push({ display: ref.logical ?? displayPath(project, ref.native), native: ref.native });
    }
    if (entries.length === 0) throw new AssetdError("USAGE_ERROR", "contact-sheet needs image paths or --search <query>");
    if (entries.length > MAX_ITEMS) throw new AssetdError("USAGE_ERROR", `At most ${MAX_ITEMS} images per contact sheet`);

    const items: ContactSheetItem[] = entries.map((e, i) => ({ label: String(i + 1), nativePath: e.native, caption: e.display.slice(e.display.lastIndexOf("/") + 1) }));
    const sheet = await renderContactSheet(items, { thumbSize: args.thumbSize, ...(args.columns ? { columns: args.columns } : {}) });

    let target: string;
    if (args.out) target = path.resolve(io.cwd, args.out);
    else {
      // Deterministic name: the same candidates (and file versions) reuse one file.
      const key = entries.map((e) => {
        let stamp = "";
        try {
          const st = fs.statSync(e.native);
          stamp = `${st.size}:${Math.trunc(st.mtimeMs)}`;
        } catch {
          // Missing files are rendered as placeholders.
        }
        return `${e.display}|${stamp}`;
      });
      const name = hashString(JSON.stringify([key, args.thumbSize, sheet.columns])).slice(0, 16);
      target = path.join(project.indexDir, "contact-sheets", `${name}.png`);
    }
    await writeFileAtomic(target, sheet.png);

    const doc: ContactSheetOutput = {
      schemaVersion: JSON_SCHEMA_VERSION,
      command: "contact-sheet",
      output: displayPath(project, target),
      width: sheet.width,
      height: sheet.height,
      columns: sheet.columns,
      rows: sheet.rows,
      items: items.map((it, i) => ({ label: it.label, path: entries[i]!.display, error: sheet.errors.get(it.label) ?? null })),
    };
    out.result(doc, () =>
      [`Contact sheet: ${doc.output} (${doc.width}x${doc.height})`, ...doc.items.map((it) => `  ${it.label.padStart(3)}  ${it.path}${it.error ? `  [error: ${it.error}]` : ""}`)].join("\n"),
    );
    return 0;
  } finally {
    store.close();
  }
}
