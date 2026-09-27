import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  contactSheetOutputSchema,
  errorOutputSchema,
  indexOutputSchema,
  inspectOutputSchema,
  searchOutputSchema,
  similarOutputSchema,
  statusOutputSchema,
} from "../../src/contracts/json.ts";
import { ExitCode } from "../../src/core/errors.ts";
import { cli, tempProject, writeImage, type TempProject } from "../helpers.ts";

let project: TempProject;

async function seed() {
  await writeImage(project, "assets/props/red chest.png", "#ff0000");
  await writeImage(project, "assets/props/blue door.png", "#0000ff");
  await writeImage(project, "assets/ui/green_icon.webp", "#00ff00", { format: "webp" });
  await writeImage(project, "assets/ui/ícone poção.png", "#ffff00", { transparentBorder: true });
  await writeImage(project, "assets/fx/white.jpg", "#ffffff", { format: "jpeg" });
  await writeImage(project, "assets/fx/anim.gif", "#ff8800", { format: "gif" });
  fs.writeFileSync(project.file("assets/ui/corrupt.png"), "definitely not a png");
  fs.writeFileSync(project.file("assets/readme.txt"), "not an asset");
}

beforeEach(async () => {
  project = tempProject();
  await seed();
});
afterEach(() => project.cleanup());

describe("assetd index", () => {
  it("indexes images, records failures without aborting, and emits the JSON contract", async () => {
    const r = await cli(project.root, "index", "assets", "--json");
    expect(r.code).toBe(ExitCode.OK);
    const doc = indexOutputSchema.parse(r.json);
    expect(doc.discovered).toBe(8);
    expect(doc.supported).toBe(7);
    expect(doc.indexed).toBe(6);
    expect(doc.failed).toBe(1);
    expect(doc.failures[0]!.path).toBe("assets/ui/corrupt.png");
    expect(doc.roots).toEqual(["assets"]);
    expect(fs.existsSync(project.file(".asset-index/index.db"))).toBe(true);
    expect(fs.readFileSync(project.file(".asset-index/.gitignore"), "utf8")).toContain("*");
  });

  it("--strict turns failures into exit code 7", async () => {
    const r = await cli(project.root, "index", "assets", "--strict", "--json");
    expect(r.code).toBe(ExitCode.PARTIAL_FAILURE);
  });

  it("is incremental: unchanged, modified, added, removed and duplicate files", async () => {
    await cli(project.root, "index", "assets");
    let r = await cli(project.root, "index", "--json");
    expect(r.json).toMatchObject({ indexed: 0, unchanged: 7, removed: 0, failed: 0 });

    // touched but identical: only a hash, still unchanged
    const door = project.file("assets/props/blue door.png");
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(door, later, later);
    // modified content
    await writeImage(project, "assets/props/red chest.png", "#00ff00");
    // removed
    fs.rmSync(project.file("assets/fx/white.jpg"));
    // added duplicate of an existing file: embedding is reused
    fs.copyFileSync(door, project.file("assets/props/door copy.png"));

    r = await cli(project.root, "index", "--json");
    expect(r.json).toMatchObject({ indexed: 2, removed: 1, reusedEmbeddings: 1 });
    expect(r.json.unchanged).toBe(5); // includes the touched door and the still-corrupt file

    r = await cli(project.root, "status", "--json");
    expect(r.json.stale).toBe(false);
    expect(r.json.assets).toBe(6);
  });

  it("retries failed files only when asked or when they change", async () => {
    await cli(project.root, "index", "assets");
    let r = await cli(project.root, "index", "--json");
    expect(r.json.failed).toBe(0);
    r = await cli(project.root, "index", "--retry-failed", "--json");
    expect(r.json.failed).toBe(1);
    await writeImage(project, "assets/ui/corrupt.png", "#123456");
    r = await cli(project.root, "index", "--json");
    expect(r.json).toMatchObject({ indexed: 1, failed: 0 });
  });

  it("honors .assetignore and removes newly ignored entries", async () => {
    await cli(project.root, "index", "assets");
    fs.writeFileSync(project.file(".assetignore"), "fx/\n");
    const r = await cli(project.root, "index", "--json");
    expect(r.json.removed).toBe(2);
  });

  it("refuses a directory outside the project and a missing directory", async () => {
    await cli(project.root, "index", "assets");
    const missing = await cli(project.root, "index", "nope", "--json");
    expect(missing.code).toBe(ExitCode.PATH_NOT_FOUND);
    errorOutputSchema.parse(missing.json);
  });

  it("reports INDEX_BUSY when another live run holds the lock", async () => {
    fs.mkdirSync(project.file(".asset-index"), { recursive: true });
    const other = process.ppid; // alive, not us
    fs.writeFileSync(project.file(".asset-index/index.lock"), JSON.stringify({ pid: other }));
    const r = await cli(project.root, "index", "assets", "--json");
    expect(r.code).toBe(ExitCode.INDEX_BUSY);
  });

  it("recovers a stale lock left by a crashed run", async () => {
    fs.mkdirSync(project.file(".asset-index"), { recursive: true });
    fs.writeFileSync(project.file(".asset-index/index.lock"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
    const r = await cli(project.root, "index", "assets", "--json");
    expect(r.code).toBe(ExitCode.OK);
    expect(fs.existsSync(project.file(".asset-index/index.lock"))).toBe(false);
  });
});

describe("assetd search / similar", () => {
  beforeEach(async () => {
    await cli(project.root, "index", "assets");
  });

  it("returns ranked, project-relative results in the JSON contract", async () => {
    const r = await cli(project.root, "search", "something", "blue", "--limit", "3", "--json");
    expect(r.code).toBe(0);
    const doc = searchOutputSchema.parse(r.json);
    expect(doc.query).toBe("something blue");
    expect(doc.results).toHaveLength(3);
    expect(doc.results[0]!.path).toBe("assets/props/blue door.png");
    expect(doc.results[0]!.rank).toBe(1);
    expect(doc.results[0]!.metadata).toMatchObject({ width: 32, height: 32, format: "png" });
    for (const res of doc.results) expect(res.path).not.toMatch(/\\|^[A-Za-z]:|^\//);
    const scores = doc.results.map((x) => x.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("uses path words as a secondary signal", async () => {
    const r = await cli(project.root, "search", "chest", "--json");
    for (const res of r.json.results) {
      expect(res.signals.lexical).toBe(res.path === "assets/props/red chest.png" ? 1 : 0);
      expect(res.score).toBeCloseTo(res.signals.visual + 0.05 * res.signals.lexical, 3);
    }
  });

  it("filters by directory and works from a subdirectory", async () => {
    const sub = project.file("assets/ui");
    const r = await cli(sub, "search", "red", "--in", ".", "--json");
    expect(r.json.within).toBe("assets/ui");
    expect(r.json.results.every((x: { path: string }) => x.path.startsWith("assets/ui/"))).toBe(true);
  });

  it("caches query embeddings", async () => {
    await cli(project.root, "search", "yellow", "--json");
    const r = await cli(project.root, "search", "yellow", "--json");
    expect(r.json.timings.queryCached).toBe(true);
  });

  it("finds similar images and flags identical files", async () => {
    fs.copyFileSync(project.file("assets/props/red chest.png"), project.file("assets/props/chest2.png"));
    await cli(project.root, "index");
    const r = await cli(project.root, "similar", "assets/props/red chest.png", "--json");
    const doc = similarOutputSchema.parse(r.json);
    expect(doc.reference).toEqual({ path: "assets/props/red chest.png", indexed: true });
    expect(doc.results.find((x) => x.path === "assets/props/red chest.png")).toBeUndefined();
    expect(doc.results[0]).toMatchObject({ path: "assets/props/chest2.png", duplicate: true });
  });

  it("accepts Windows-style separators and odd casing from agents", async () => {
    const r = await cli(project.root, "similar", "ASSETS\\PROPS\\RED CHEST.PNG", "--json");
    expect(r.code).toBe(0);
    expect(r.json.reference.path).toBe("assets/props/red chest.png");
  });

  it("embeds reference images that are not indexed", async () => {
    const outside = tempProject();
    try {
      await writeImage(outside, "ref.png", "#0000ff");
      const r = await cli(project.root, "similar", outside.file("ref.png"), "--json");
      expect(r.code).toBe(0);
      expect(r.json.reference.indexed).toBe(false);
      expect(r.json.results[0].path).toBe("assets/props/blue door.png");
    } finally {
      outside.cleanup();
    }
  });

  it("uses documented exit codes for errors", async () => {
    expect((await cli(project.root, "similar", "missing.png", "--json")).code).toBe(ExitCode.PATH_NOT_FOUND);
    expect((await cli(project.root, "similar", "assets/readme.txt", "--json")).code).toBe(ExitCode.NOT_INDEXED);
    expect((await cli(project.root, "search", "x", "--type", "video", "--json")).code).toBe(ExitCode.USAGE_ERROR);
    expect((await cli(project.root, "search", "x", "--bogus", "--json")).code).toBe(ExitCode.USAGE_ERROR);
    expect((await cli(project.root, "frobnicate")).code).toBe(ExitCode.USAGE_ERROR);
  });
});

describe("assetd inspect / status / contact-sheet", () => {
  it("status reports no index without failing", async () => {
    const r = await cli(project.root, "status", "--json");
    expect(r.code).toBe(0);
    expect(statusOutputSchema.parse(r.json)).toMatchObject({ indexed: false, assets: 0 });
  });

  it("commands needing an index fail with INDEX_NOT_FOUND", async () => {
    const r = await cli(project.root, "search", "x", "--json");
    expect(r.code).toBe(ExitCode.INDEX_NOT_FOUND);
    expect(errorOutputSchema.parse(r.json).error.code).toBe("INDEX_NOT_FOUND");
    expect(r.stderr).toContain("error:");
  });

  it("status describes the index and detects staleness", async () => {
    await cli(project.root, "index", "assets");
    let r = await cli(project.root, "status", "--json");
    const doc = statusOutputSchema.parse(r.json);
    expect(doc).toMatchObject({ indexed: true, root: ".", roots: ["assets"], assets: 6, types: { image: 6 }, failed: 1, stale: false, indexVersion: 1 });
    expect(doc.model).toMatchObject({ provider: "test-hash", cached: true });
    await writeImage(project, "assets/new.png", "#abcdef");
    r = await cli(project.root, "status", "--json");
    expect(r.json.stale).toBe(true);
    expect(r.json.staleness.added).toBe(1);
    r = await cli(project.root, "ensure-index", "--json");
    expect(r.json.indexed).toBe(1);
  });

  it("inspect reports metadata and state for each situation", async () => {
    await cli(project.root, "index", "assets");
    let r = await cli(project.root, "inspect", "assets/ui/ícone poção.png", "--json");
    const doc = inspectOutputSchema.parse(r.json);
    expect(doc).toMatchObject({ state: "indexed", kind: "image", extension: "png" });
    expect(doc.metadata).toMatchObject({ width: 32, height: 32, hasAlphaChannel: true, hasTransparency: true, aspect: "1:1" });
    expect(doc.embeddings[0]).toMatchObject({ channel: "visual", current: true });
    expect(JSON.stringify(doc)).not.toMatch(/"vector"/);

    r = await cli(project.root, "inspect", "assets/ui/corrupt.png", "--json");
    expect(r.json.state).toBe("failed");

    await writeImage(project, "assets/late.png", "#010203");
    r = await cli(project.root, "inspect", "assets/late.png", "--json");
    expect(r.json).toMatchObject({ state: "not-indexed", metadata: { width: 32 } });

    r = await cli(project.root, "inspect", "assets/readme.txt", "--json");
    expect(r.json.state).toBe("unsupported");

    fs.rmSync(project.file("assets/fx/white.jpg"));
    r = await cli(project.root, "inspect", "assets/fx/white.jpg", "--json");
    expect(r.json.state).toBe("missing");

    await writeImage(project, "assets/props/blue door.png", "#0000fe");
    r = await cli(project.root, "inspect", "assets/props/blue door.png", "--json");
    expect(r.json.state).toBe("stale");

    r = await cli(project.root, "inspect", "assets/fx/anim.gif", "--json");
    expect(r.json.metadata.format).toBe("gif");
  });

  it("contact-sheet renders labeled candidates to a PNG", async () => {
    await cli(project.root, "index", "assets");
    const r = await cli(project.root, "contact-sheet", "assets/props/red chest.png", "assets/ui/corrupt.png", "--search", "blue", "--limit", "2", "--json");
    expect(r.code).toBe(0);
    const doc = contactSheetOutputSchema.parse(r.json);
    expect(doc.items.map((i) => i.label)).toEqual(["1", "2", "3", "4"]);
    expect(doc.items[0]!.path).toBe("assets/props/blue door.png");
    expect(doc.items.find((i) => i.path === "assets/ui/corrupt.png")!.error).not.toBeNull();
    expect(doc.output.startsWith(".asset-index/contact-sheets/")).toBe(true);
    const png = fs.readFileSync(path.join(project.root, ...doc.output.split("/")));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    // deterministic output name for identical input
    const again = await cli(project.root, "contact-sheet", "assets/props/red chest.png", "assets/ui/corrupt.png", "--search", "blue", "--limit", "2", "--json");
    expect(again.json.output).toBe(doc.output);
  });
});

describe("output hygiene", () => {
  it("--json stdout is exactly one JSON document; human mode has no ANSI codes", async () => {
    const idx = await cli(project.root, "index", "assets", "--json");
    expect(() => JSON.parse(idx.stdout)).not.toThrow();
    const human = await cli(project.root, "search", "red");
    expect(human.stdout).not.toMatch(/\u001b\[/);
    expect(human.stdout.split("\n")[0]).toMatch(/^\d\.\d{3} {2}assets\//);
  });

  it("prints help and version", async () => {
    expect((await cli(project.root, "--help")).stdout).toContain("Commands:");
    expect((await cli(project.root, "search", "--help")).stdout).toContain("Usage:");
    expect((await cli(project.root, "--version")).stdout).toMatch(/^\d+\.\d+\.\d+/);
  });
});
