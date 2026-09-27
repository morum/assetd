import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../src/cli/run.ts";
import { tempProject, type TempProject } from "../helpers.ts";

/**
 * Real-model integration test for audio (CLAP via ONNX Runtime, CPU, WASM
 * decoders). Needs ASSETD_MODEL_DIR, like the SigLIP suite.
 */
const modelDir = process.env.ASSETD_MODEL_DIR;
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "audio");

let project: TempProject;

async function assetd(...argv: string[]) {
  let stdout = "";
  const code = await run(argv, { stdout: (t) => void (stdout += t), stderr: () => undefined, cwd: project.root, env: { ASSETD_MODEL_DIR: modelDir! }, stderrIsTTY: false });
  return { code, json: JSON.parse(stdout) };
}

describe("CLAP end to end", () => {
  beforeAll(() => {
    if (!modelDir) throw new Error("Set ASSETD_MODEL_DIR to run the model suite (weights are downloaded there once).");
    project = tempProject();
    fs.mkdirSync(project.file("sfx"));
    // Neutral names: only the model sees content.
    fs.copyFileSync(path.join(FIXTURES, "tone 440.ogg"), project.file("sfx/a.ogg"));
    fs.copyFileSync(path.join(FIXTURES, "noise_burst.mp3"), project.file("sfx/b.mp3"));
  });
  afterAll(() => project?.cleanup());

  it("indexes sounds and ranks them by meaning", async () => {
    const idx = await assetd("index", "sfx", "--json");
    expect(idx.code).toBe(0);
    expect(idx.json.indexed).toBe(2);
    const noise = await assetd("search", "white noise static hiss", "--type", "audio", "--json");
    expect(noise.json.results[0].path).toBe("sfx/b.mp3");
    const tone = await assetd("search", "a pure electronic beep tone", "--type", "audio", "--json");
    expect(tone.json.results[0].path).toBe("sfx/a.ogg");
    const sim = await assetd("similar", "sfx/a.ogg", "--json");
    expect(sim.json.results[0].path).toBe("sfx/b.mp3");
  });
});
