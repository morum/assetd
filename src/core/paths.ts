import path from "node:path";

/**
 * Path strategy
 * -------------
 * Native paths: absolute, platform-specific; used only to touch the filesystem.
 * Logical paths: project-relative, always "/"-separated, never starting with
 * "./" or "/", never containing "..". They are the asset identity in the index
 * and the only form printed to humans and agents.
 *
 * Logical paths keep the exact code points reported by the filesystem so they
 * can always be mapped back to a native path. Comparisons against user input
 * use `pathMatchKey`, which is Unicode-normalized (NFC) and case-folded so that
 * lookups behave the same on case-insensitive (Windows) and case-sensitive
 * (Linux) filesystems.
 */

export type PathApi = typeof path.posix | typeof path.win32;

export const nativePath: PathApi = path;

/** Converts an absolute native path into a logical path, or null when outside `projectRoot`. */
export function toLogicalPath(projectRoot: string, absolute: string, api: PathApi = nativePath): string | null {
  const rel = api.relative(projectRoot, absolute);
  if (rel === "") return "";
  if (api.isAbsolute(rel)) return null; // e.g. a different Windows drive
  const segments = rel.split(api.sep);
  if (segments[0] === "..") return null;
  return segments.join("/");
}

/** Converts a logical path back to an absolute native path. */
export function toNativePath(projectRoot: string, logical: string, api: PathApi = nativePath): string {
  if (logical === "") return projectRoot;
  return api.join(projectRoot, ...logical.split("/"));
}

/**
 * Normalizes a logical path typed by a user or agent: accepts either
 * separator, strips "./" and redundant separators. Returns null for paths that
 * escape the project or are absolute.
 */
export function normalizeLogicalInput(input: string): string | null {
  const unified = input.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) return null;
  const out: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/** Key used for tolerant lookups (Unicode NFC + case folding). */
export function pathMatchKey(logical: string): string {
  return logical.normalize("NFC").toLowerCase();
}

/** Extension in lower case without the dot ("PNG" -> "png"). */
export function extensionOf(logical: string): string {
  const base = logical.slice(logical.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** True when `logical` equals `root` or lies below it (logical paths). */
export function isWithinLogical(root: string, logical: string): boolean {
  if (root === "") return true;
  return logical === root || logical.startsWith(root + "/");
}

/** Splits a path into lower-case word tokens for lexical ranking. */
export function pathTokens(logical: string): string[] {
  return logical
    .replace(/\.[^./]+$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}
