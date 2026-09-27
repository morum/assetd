import fs from "node:fs";
import path from "node:path";
import { normalizeLogicalInput, toLogicalPath, toNativePath } from "../core/paths.ts";
import type { Project } from "../core/project.ts";
import { resolveVisualModel } from "../embeddings/presets.ts";
import { createVisualProvider } from "../embeddings/registry.ts";
import type { VisualEmbeddingProvider } from "../embeddings/types.ts";
import type { IndexStore } from "../storage/index-store.ts";
import type { Output } from "./io.ts";

/** Project root as shown to users: relative to the cwd when inside it, "/"-separated. */
export function displayRoot(project: Project, cwd: string): string {
  const rel = toLogicalPath(cwd, project.root);
  if (rel === null) return project.root.split(path.sep).join("/");
  return rel === "" ? "." : rel;
}

/** A path as shown to users: logical when inside the project, else native absolute. */
export function displayPath(project: Project, native: string): string {
  return toLogicalPath(project.root, native) ?? native;
}

export function modelInfo(project: Project, provider: VisualEmbeddingProvider) {
  const spec = resolveVisualModel(project.config.models.visual, project.config.models.dtype);
  return {
    space: provider.space.id,
    provider: provider.space.provider,
    model: spec.name === spec.repo ? spec.repo : `${spec.name} (${spec.repo})`,
    dtype: spec.dtype,
    dimensions: provider.space.dimensions,
  };
}

function formatBytes(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/** Provider whose model downloads report on stderr (never stdout). */
export function providerFor(project: Project, out: Output): VisualEmbeddingProvider {
  const announced = new Set<string>();
  return createVisualProvider(project.config, {
    env: out.io.env,
    onProgress: (e) => {
      if (e.status === "progress" && e.total && e.total > 5 * 1048576) {
        if (!announced.has(e.file)) {
          announced.add(e.file);
          out.info(`Downloading model file ${e.file} (${formatBytes(e.total)}) to the local model cache...`);
        }
        out.progress(`  ${e.file}: ${Math.floor(((e.loaded ?? 0) / e.total) * 100)}%`);
      } else if (e.status === "done" && announced.has(e.file)) {
        out.clearProgress();
        out.info(`  ${e.file}: done`);
      }
    },
  });
}

export interface ResolvedAssetPath {
  /** Logical path, or null when the path lies outside the project. */
  logical: string | null;
  native: string;
  exists: boolean;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves a user/agent-supplied path. Accepted forms: relative to the cwd,
 * absolute, or project-relative logical ("assets/a.png", either separator).
 * Falls back to a case/Unicode-insensitive index lookup.
 */
export function resolveAssetInput(project: Project, cwd: string, rawInput: string, store?: IndexStore): ResolvedAssetPath {
  // Agents often emit Windows separators; on POSIX a backslash is a legal filename
  // character, so only reinterpret it when the literal path does not exist.
  const input = path.sep === "/" && rawInput.includes("\\") && !isFile(path.resolve(cwd, rawInput)) ? rawInput.replace(/\\/g, "/") : rawInput;
  const absolute = path.resolve(cwd, input);
  const fromCwd = toLogicalPath(project.root, absolute);
  if (fromCwd !== null && isFile(absolute)) return { logical: fromCwd, native: absolute, exists: true };
  const asLogical = normalizeLogicalInput(input);
  if (asLogical) {
    const native = toNativePath(project.root, asLogical);
    if (isFile(native)) return { logical: asLogical, native, exists: true };
  }
  if (store) {
    for (const candidate of [fromCwd, asLogical]) {
      if (!candidate) continue;
      const exact = store.getAsset(candidate);
      if (exact) return { logical: exact.path, native: toNativePath(project.root, exact.path), exists: isFile(toNativePath(project.root, exact.path)) };
      const loose = store.findAssetsByMatchKey(candidate);
      if (loose.length === 1) {
        const native = toNativePath(project.root, loose[0]!.path);
        return { logical: loose[0]!.path, native, exists: isFile(native) };
      }
    }
  }
  if (fromCwd !== null) return { logical: fromCwd, native: absolute, exists: false };
  return { logical: null, native: absolute, exists: isFile(absolute) };
}
