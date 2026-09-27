import fs from "node:fs/promises";
import type { IgnoreMatcher } from "./ignore.ts";
import { extensionOf, toNativePath } from "./paths.ts";
import type { FileInfo } from "./types.ts";

export interface DiscoveryIssue {
  path: string;
  error: string;
  /** The directory does not exist (as opposed to exists but cannot be read). */
  missing?: boolean;
}

export interface DiscoveryResult {
  /** Files accepted by `accept`, with stat information. */
  files: FileInfo[];
  /** Every regular file seen (after ignore rules). */
  seen: number;
  issues: DiscoveryIssue[];
}

export interface DiscoveryOptions {
  projectRoot: string;
  /** Logical directories to scan ("" = whole project). */
  roots: string[];
  ignore: IgnoreMatcher;
  /** Cheap pre-filter on the logical path, applied before stat. */
  accept: (logical: string) => boolean;
  signal?: AbortSignal;
}

/**
 * Recursively lists files under the given roots. Directory symlinks are not
 * followed (avoids cycles and keeps behavior identical where symlinks are
 * unavailable); file symlinks are resolved with stat. Unreadable entries are
 * reported as issues and never abort discovery.
 */
export async function discoverFiles(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const files: FileInfo[] = [];
  const issues: DiscoveryIssue[] = [];
  let seen = 0;
  const visited = new Set<string>();
  const stack = [...opts.roots];

  while (stack.length > 0) {
    if (opts.signal?.aborted) break;
    const dirLogical = stack.pop()!;
    if (visited.has(dirLogical)) continue;
    visited.add(dirLogical);
    const dirNative = toNativePath(opts.projectRoot, dirLogical);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dirNative, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      issues.push({ path: dirLogical || ".", error: (err as Error).message, ...(code === "ENOENT" || code === "ENOTDIR" ? { missing: true } : {}) });
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const logical = dirLogical === "" ? entry.name : `${dirLogical}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!opts.ignore.ignores(logical, true)) stack.push(logical);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (opts.ignore.ignores(logical, false)) continue;
      const native = toNativePath(opts.projectRoot, logical);
      if (entry.isSymbolicLink()) {
        try {
          if (!(await fs.stat(native)).isFile()) continue;
        } catch {
          continue; // dangling link
        }
      }
      seen++;
      if (!opts.accept(logical)) continue;
      try {
        const st = await fs.stat(native);
        files.push({
          logicalPath: logical,
          nativePath: native,
          extension: extensionOf(logical),
          size: st.size,
          modifiedAtMs: Math.trunc(st.mtimeMs),
        });
      } catch (err) {
        // File vanished or became unreadable between readdir and stat.
        issues.push({ path: logical, error: (err as Error).message });
      }
    }
  }
  files.sort((a, b) => (a.logicalPath < b.logicalPath ? -1 : a.logicalPath > b.logicalPath ? 1 : 0));
  return { files, seen, issues };
}
