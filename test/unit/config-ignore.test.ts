import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig } from "../../src/core/config.ts";
import { discoverFiles } from "../../src/core/discovery.ts";
import { AssetdError } from "../../src/core/errors.ts";
import { createIgnoreMatcher } from "../../src/core/ignore.ts";
import { resolveModelCacheDir } from "../../src/embeddings/model-cache.ts";
import { tempProject, type TempProject } from "../helpers.ts";

let project: TempProject;
afterEach(() => project?.cleanup());

function touch(logical: string, content = "x") {
  const f = project.file(logical);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

describe("config", () => {
  it("is zero-config by default with images only", () => {
    project = tempProject();
    const c = loadConfig(project.root, {});
    expect(c.processors).toEqual({ image: true, audio: false, model3d: false, video: false, text: false });
    expect(c.models.visual).toBe("siglip-base");
  });
  it("reports invalid configuration as a usage error", () => {
    project = tempProject();
    fs.writeFileSync(project.file("assetd.json"), JSON.stringify({ processors: { image: "yes" } }));
    expect(() => loadConfig(project.root, {})).toThrow(AssetdError);
  });
  it("accepts a BOM and environment overrides", () => {
    project = tempProject();
    fs.writeFileSync(project.file("assetd.json"), "\uFEFF" + JSON.stringify({ roots: ["assets"] }));
    const c = loadConfig(project.root, { ASSETD_VISUAL_MODEL: "test-hash" });
    expect(c.roots).toEqual(["assets"]);
    expect(c.models.visual).toBe("test-hash");
  });
});

describe("ignore rules", () => {
  it("applies defaults, .assetignore and case-insensitive matching", async () => {
    project = tempProject();
    touch(".assetignore", "build/\n*.TMP\n# comment\n\ncache/**\n");
    for (const f of ["a.png", "build/b.png", "sub/build/c.png", "x.tmp", "node_modules/d.png", ".git/e.png", "cache/f.png", "Build/g.png", "keep/h.png"]) touch(f);
    const ig = createIgnoreMatcher(project.root, defaultConfig());
    const { files } = await discoverFiles({ projectRoot: project.root, roots: [""], ignore: ig, accept: () => true });
    expect(files.map((f) => f.logicalPath)).toEqual([".assetignore", "a.png", "keep/h.png"]);
  });
  it("optionally respects .gitignore", async () => {
    project = tempProject();
    touch(".gitignore", "secret/\n");
    touch("secret/a.png");
    touch("b.png");
    const on = createIgnoreMatcher(project.root, { ...defaultConfig(), respectGitignore: true });
    const off = createIgnoreMatcher(project.root, defaultConfig());
    expect(on.ignores("secret", true)).toBe(true);
    expect(off.ignores("secret", true)).toBe(false);
  });
  it("always ignores the index directory", () => {
    project = tempProject();
    const ig = createIgnoreMatcher(project.root, { ...defaultConfig(), defaultIgnores: false });
    expect(ig.ignores(".asset-index", true)).toBe(true);
    expect(ig.ignores("node_modules", true)).toBe(false);
  });
});

describe("discovery", () => {
  it("handles spaces and Unicode names and reports stat info", async () => {
    project = tempProject();
    touch("ícones com espaço/poção de vida.png", "abc");
    const { files, seen } = await discoverFiles({
      projectRoot: project.root,
      roots: [""],
      ignore: createIgnoreMatcher(project.root, defaultConfig()),
      accept: () => true,
    });
    expect(seen).toBe(1);
    expect(files[0]!.logicalPath).toBe("ícones com espaço/poção de vida.png");
    expect(files[0]!.size).toBe(3);
    expect(files[0]!.extension).toBe("png");
  });
  it("reports unreadable roots instead of throwing", async () => {
    project = tempProject();
    const res = await discoverFiles({
      projectRoot: project.root,
      roots: ["does-not-exist"],
      ignore: createIgnoreMatcher(project.root, defaultConfig()),
      accept: () => true,
    });
    expect(res.files).toEqual([]);
    expect(res.issues).toHaveLength(1);
  });
});

describe("model cache location", () => {
  it("uses LOCALAPPDATA on Windows", () => {
    expect(resolveModelCacheDir({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Local\\assetd\\models");
  });
  it("uses XDG_CACHE_HOME or ~/.cache on Linux", () => {
    expect(resolveModelCacheDir({ XDG_CACHE_HOME: "/xdg" }, "linux", "/home/u")).toBe("/xdg/assetd/models");
    expect(resolveModelCacheDir({}, "linux", "/home/u")).toBe("/home/u/.cache/assetd/models");
  });
  it("honors ASSETD_MODEL_DIR", () => {
    expect(resolveModelCacheDir({ ASSETD_MODEL_DIR: "models" }, "linux", "/home/u")).toMatch(/models$/);
  });
});
