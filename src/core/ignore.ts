import fs from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import type { AssetdConfig } from "./config.ts";
import { INDEX_DIR_NAME } from "./project.ts";

export const IGNORE_FILE_NAME = ".assetignore";

/** Always ignored, even with defaultIgnores=false: the index itself. */
const MANDATORY_IGNORES = [`${INDEX_DIR_NAME}/`];

/** Built-in ignores: VCS metadata, package managers, engine caches/import dirs. */
export const DEFAULT_IGNORES = [".git/", ".hg/", ".svn/", "node_modules/", ".godot/", ".import/"];

export interface IgnoreMatcher {
  /** `logical` is a project-relative "/"-path; `isDir` enables directory-only patterns. */
  ignores(logical: string, isDir: boolean): boolean;
  sources: string[];
}

function readPatterns(file: string): string[] | null {
  try {
    return fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/);
  } catch {
    return null;
  }
}

/**
 * Builds the matcher from, in order: mandatory ignores, defaults,
 * `.assetignore` at the project root, optional root `.gitignore`, config.ignore.
 * Matching is case-insensitive on every platform so that results do not depend
 * on the filesystem.
 */
export function createIgnoreMatcher(projectRoot: string, config: AssetdConfig): IgnoreMatcher {
  const ig: Ignore = ignore({ ignorecase: true });
  const sources: string[] = [];
  ig.add(MANDATORY_IGNORES);
  if (config.defaultIgnores) {
    ig.add(DEFAULT_IGNORES);
    sources.push("defaults");
  }
  const assetIgnore = readPatterns(path.join(projectRoot, IGNORE_FILE_NAME));
  if (assetIgnore) {
    ig.add(assetIgnore);
    sources.push(IGNORE_FILE_NAME);
  }
  if (config.respectGitignore) {
    const gitIgnore = readPatterns(path.join(projectRoot, ".gitignore"));
    if (gitIgnore) {
      ig.add(gitIgnore);
      sources.push(".gitignore");
    }
  }
  if (config.ignore.length > 0) {
    ig.add(config.ignore);
    sources.push("assetd.json");
  }
  return {
    sources,
    ignores(logical, isDir) {
      if (logical === "") return false;
      return ig.ignores(isDir ? `${logical}/` : logical);
    },
  };
}
