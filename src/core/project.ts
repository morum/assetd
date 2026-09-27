import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE_NAME, loadConfig, type AssetdConfig } from "./config.ts";
import { AssetdError } from "./errors.ts";
import { toLogicalPath } from "./paths.ts";

export const INDEX_DIR_NAME = ".asset-index";
export const INDEX_DB_NAME = "index.db";
export const PREVIEWS_DIR_NAME = "previews";

export interface Project {
  /** Absolute native project root; logical paths are relative to it. */
  root: string;
  /** Absolute native path of the index directory. */
  indexDir: string;
  dbPath: string;
  /** Derived previews: `<previewDir>/<contentHash>/<name>.png`. */
  previewDir: string;
  config: AssetdConfig;
}

function hasIndex(dir: string): boolean {
  return fs.existsSync(path.join(dir, INDEX_DIR_NAME, INDEX_DB_NAME));
}

function hasConfig(dir: string): boolean {
  return fs.existsSync(path.join(dir, CONFIG_FILE_NAME));
}

/** Walks up from `start` looking for an existing index or an assetd.json. */
export function findProjectRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (hasIndex(dir) || hasConfig(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function openProject(root: string, env: NodeJS.ProcessEnv = process.env): Project {
  const indexDir = path.join(root, INDEX_DIR_NAME);
  return { root, indexDir, dbPath: path.join(indexDir, INDEX_DB_NAME), previewDir: path.join(indexDir, PREVIEWS_DIR_NAME), config: loadConfig(root, env) };
}

export interface ResolveOptions {
  cwd: string;
  /** Value of --project. */
  projectFlag?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

/** Resolves the project for read commands (search, status, ...). */
export function resolveExistingProject(opts: ResolveOptions): Project | null {
  const root = opts.projectFlag ? path.resolve(opts.cwd, opts.projectFlag) : findProjectRoot(opts.cwd);
  if (!root) return null;
  return openProject(root, opts.env);
}

export function requireIndexedProject(opts: ResolveOptions): Project {
  const project = resolveExistingProject(opts);
  if (!project || !fs.existsSync(project.dbPath)) {
    throw new AssetdError(
      "INDEX_NOT_FOUND",
      "No asset index found. Run `assetd index <directory>` from the project root first.",
      { searchedFrom: opts.cwd },
    );
  }
  return project;
}

/**
 * Resolves the project for `assetd index <dirs...>`:
 * --project wins, then an existing index/config above the cwd or the target,
 * then the cwd when the targets lie inside it, else the first target itself.
 */
export function resolveProjectForIndex(opts: ResolveOptions & { targets: string[] }): Project {
  if (opts.projectFlag) return openProject(path.resolve(opts.cwd, opts.projectFlag), opts.env);
  const fromCwd = findProjectRoot(opts.cwd);
  const absTargets = opts.targets.map((t) => path.resolve(opts.cwd, t));
  if (fromCwd && absTargets.every((t) => toLogicalPath(fromCwd, t) !== null)) return openProject(fromCwd, opts.env);
  const first = absTargets[0];
  if (first) {
    const fromTarget = findProjectRoot(first);
    if (fromTarget && absTargets.every((t) => toLogicalPath(fromTarget, t) !== null)) {
      return openProject(fromTarget, opts.env);
    }
  }
  if (absTargets.every((t) => toLogicalPath(opts.cwd, t) !== null)) return openProject(path.resolve(opts.cwd), opts.env);
  if (first && absTargets.length === 1) return openProject(first, opts.env);
  throw new AssetdError("USAGE_ERROR", "Index targets must share one project root. Use --project <dir>.");
}
