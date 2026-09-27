import { createRequire } from "node:module";

type SqliteModule = typeof import("node:sqlite");

let cached: SqliteModule | undefined;

/**
 * Loads the built-in `node:sqlite` module (no native addon to install, same
 * behavior on Windows and Linux). On Node versions where it still prints an
 * ExperimentalWarning, that one warning is suppressed so stderr stays clean.
 */
export function loadSqlite(): SqliteModule {
  if (cached) return cached;
  const originalEmit = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === "string" ? warning : warning.message;
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === "ExperimentalWarning" && /sqlite/i.test(text)) return;
    return (originalEmit as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    cached = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
  } finally {
    process.emitWarning = originalEmit;
  }
  return cached;
}
