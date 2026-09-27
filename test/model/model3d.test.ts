import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../src/cli/run.ts";
import { tempProject, writeImage, type TempProject } from "../helpers.ts";

/** Real-model test for 3D: software renders embedded with SigLIP. Needs ASSETD_MODEL_DIR. */
const modelDir = process.env.ASSETD_MODEL_DIR;
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "models");

let project: TempProject;

async function assetd(...argv: string[]) {
  let stdout = "";
  const code = await run(argv, { stdout: (t) => void (stdout += t), stderr: () => undefined, cwd: project.root, env: { ASSETD_MODEL_DIR: modelDir! }, stderrIsTTY: false });
  return { code, json: JSON.parse(stdout) };
}

describe("3D models end to end", () => {
  beforeAll(async () => {
    if (!modelDir) throw new Error("Set ASSETD_MODEL_DIR to run the model suite (weights are downloaded there once).");
    project = tempProject();
    fs.mkdirSync(project.file("m/Textures"), { recursive: true });
    // Neutral names: only the renders carry meaning.
    fs.copyFileSync(path.join(FIXTURES, "burger.glb"), project.file("m/a.glb"));
    fs.copyFileSync(path.join(FIXTURES, "Textures", "colormap.png"), project.file("m/Textures/colormap.png"));
    // A plain OBJ cube as a distractor.
    fs.writeFileSync(
      project.file("m/b.obj"),
      "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0 0 1\nv 1 0 1\nv 1 1 1\nv 0 1 1\nf 1 2 3 4\nf 5 8 7 6\nf 1 5 6 2\nf 4 3 7 8\nf 2 6 7 3\nf 1 4 8 5\n",
    );
    await writeImage(project, "icons/x.png", "#3060d0");
  });
  afterAll(() => project?.cleanup());

  it("finds a model from a description of what it looks like", async () => {
    const idx = await assetd("index", "m", "icons", "--json");
    expect(idx.code).toBe(0);
    expect(idx.json.failed).toBe(0);
    const burger = await assetd("search", "a hamburger", "--type", "model3d", "--json");
    expect(burger.json.results[0].path).toBe("m/a.glb");
    const cube = await assetd("search", "a plain grey cube", "--type", "model3d", "--json");
    expect(cube.json.results[0].path).toBe("m/b.obj");
    const toImage = await assetd("similar", "m/a.glb", "--type", "image", "--json");
    expect(toImage.code).toBe(0);
  });
});
