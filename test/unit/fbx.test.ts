import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectOutputSchema, similarOutputSchema } from "../../src/contracts/json.ts";
import { fbxVersion, loadFbx, normalizeAsciiFbx, resolveTexture } from "../../src/processors/model3d/fbx-loader.ts";
import { loadGltf } from "../../src/processors/model3d/gltf-loader.ts";
import { describeScene } from "../../src/processors/model3d/model-scene.ts";
import { cli, tempProject, type TempProject } from "../helpers.ts";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "models");
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name));

describe("FBX loading", () => {
  it("reads binary FBX and matches the GLB export of the same model", async () => {
    expect(fbxVersion(read("burger.fbx"))).toBe(7700);
    const fbx = describeScene(await loadFbx(path.join(FIXTURES, "burger.fbx"), read("burger.fbx")));
    const glb = describeScene(await loadGltf(path.join(FIXTURES, "burger.glb"), read("burger.glb")));
    expect(fbx).toMatchObject({ format: "fbx", sourceVersion: "7.7", units: "meters", upAxis: "Y", missingResources: [] });
    expect(fbx.triangleCount).toBe(glb.triangleCount);
    expect(fbx.dimensions).toEqual(glb.dimensions);
    // The FBX stores a bare "colormap.png"; it is found in the Textures folder.
    expect(fbx.textures).toEqual([expect.objectContaining({ uri: "colormap.png", missing: false })]);
  });

  it("reads ASCII FBX whose exporter mis-indents braces and leaves dangling commas", async () => {
    const scene = await loadFbx(path.join(FIXTURES, "chair.fbx"), read("chair.fbx"));
    const glb = await loadGltf(path.join(FIXTURES, "chair.glb"), read("chair.glb"));
    expect(scene.triangleCount).toBe(glb.triangleCount);
    // Every triangle resolves to a named material (the comma bug left half of them unassigned).
    expect(scene.primitives.every((p) => p.materialName)).toBe(true);
    expect(scene.primitives.length).toBe(new Set(scene.primitives.map((p) => p.materialName)).size);
    expect(scene.primitives.every((p) => p.uvs)).toBe(true);
    expect(describeScene(scene).sourceUnitScale).toBe(100);
  });

  it("normalizes indentation by brace depth and drops a dangling array comma", () => {
    const input = ["Geometry: 1 {", "\tUV: *2 {", "\t\ta: 1,2", "\t\t}", "\tMaterials: *2 {", "a: 0,1,", "}", "}", ""].join("\r\n");
    expect(normalizeAsciiFbx(input).split("\n")).toEqual(["Geometry: 1 {", "\tUV: *2 {", "\t\ta: 1,2", "\t}", "\tMaterials: *2 {", "\t\ta: 0,1", "\t}", "}", ""]);
    // A comma followed by a continuation line is kept.
    expect(normalizeAsciiFbx("X: {\na: 1,\n2,3\n}")).toBe("X: {\n\ta: 1,\n\t2,3\n}");
  });

  it("refuses FBX older than 6.1 with a clear message", async () => {
    await expect(loadFbx("old.fbx", Buffer.from("; FBX 6.0.0 project file\n"))).rejects.toThrow(/too old/);
  });
});

describe("FBX texture lookup", () => {
  let project: TempProject;
  beforeEach(() => {
    project = tempProject();
  });
  afterEach(() => project.cleanup());

  it("finds textures referenced by the exporting machine's absolute Windows path", async () => {
    fs.mkdirSync(project.file("models/Textures"), { recursive: true });
    fs.writeFileSync(project.file("models/Textures/wood.png"), "png");
    expect(await resolveTexture(project.file("models"), "C:\\Users\\artist\\Desktop\\wood.png")).not.toBeNull();
    expect(await resolveTexture(project.file("models"), "Textures/wood.png")).not.toBeNull();
    expect(await resolveTexture(project.file("models"), "/home/artist/missing.png")).toBeNull();
  });

  it("indexes FBX files and compares them with other formats of the same model", async () => {
    fs.cpSync(FIXTURES, project.file("models"), { recursive: true });
    const r = await cli(project.root, "index", "models", "--json");
    expect(r.json.failed).toBe(0);
    const doc = inspectOutputSchema.parse((await cli(project.root, "inspect", "models/burger.fbx", "--json")).json);
    expect(doc).toMatchObject({ kind: "model3d", state: "indexed", extension: "fbx" });
    expect(doc.previews).toHaveLength(1);
    const sim = similarOutputSchema.parse((await cli(project.root, "similar", "models/burger.fbx", "--json")).json);
    expect(sim.results.slice(0, 2).map((x) => x.path).sort()).toEqual(["models/burger.glb", "models/burger.obj"]);
  });
});
