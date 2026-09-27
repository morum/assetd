import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../src/cli/run.ts";
import { tempProject, type TempProject } from "../helpers.ts";

/**
 * Real-model integration test (SigLIP via ONNX Runtime, CPU). Downloads ~200 MB
 * of weights on first use into ASSETD_MODEL_DIR, which must be set explicitly
 * so the suite never writes into a developer's personal cache by accident.
 * Run with: ASSETD_MODEL_DIR=<dir> npm run test:model
 */
const modelDir = process.env.ASSETD_MODEL_DIR;

const SHAPES: Record<string, string> = {
  "art/a1.png": `<rect width="256" height="256" fill="white"/><circle cx="128" cy="128" r="96" fill="#d01010"/>`,
  "art/a2.png": `<rect width="256" height="256" fill="white"/><rect x="40" y="40" width="176" height="176" fill="#1030d0"/>`,
  "art/a3.png": `<rect width="256" height="256" fill="white"/><polygon points="128,24 236,228 20,228" fill="#10a020"/>`,
  "art/a4.png": `<rect width="256" height="256" fill="#87ceeb"/><circle cx="128" cy="100" r="50" fill="#ffd700"/><rect y="180" width="256" height="76" fill="#228b22"/>`,
};

let project: TempProject;

async function assetd(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    cwd: project.root,
    env: { ASSETD_MODEL_DIR: modelDir! },
    stderrIsTTY: false,
  });
  return { code, json: argv.includes("--json") ? JSON.parse(stdout) : undefined, stderr };
}

describe("SigLIP end to end", () => {
  beforeAll(async () => {
    if (!modelDir) throw new Error("Set ASSETD_MODEL_DIR to run the model suite (weights are downloaded there once).");
    project = tempProject();
    for (const [logical, body] of Object.entries(SHAPES)) {
      const file = project.file(logical);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">${body}</svg>`)).png().toFile(file);
    }
  });
  afterAll(() => project?.cleanup());

  it("indexes, then answers text and image queries by meaning (filenames carry no hints)", async () => {
    const t0 = performance.now();
    const idx = await assetd("index", "art", "--json");
    expect(idx.code).toBe(0);
    expect(idx.json.indexed).toBe(4);
    const indexMs = performance.now() - t0;

    const expectTop = async (query: string, expected: string) => {
      const r = await assetd("search", query, "--limit", "4", "--json");
      expect(r.code).toBe(0);
      expect(r.json.results[0].path, `query "${query}"`).toBe(expected);
      return r.json.timings;
    };
    const timings = await expectTop("a red circle", "art/a1.png");
    await expectTop("a blue square", "art/a2.png");
    await expectTop("a green triangle", "art/a3.png");
    await expectTop("a sunny landscape with grass", "art/a4.png");

    const sim = await assetd("similar", "art/a1.png", "--json");
    expect(sim.code).toBe(0);
    expect(sim.json.results).toHaveLength(3);

    const status = await assetd("status", "--json");
    expect(status.json.model).toMatchObject({ provider: "siglip", cached: true, dimensions: 768 });
    console.error(`[model] index 4 images: ${indexMs.toFixed(0)} ms; first search: ${JSON.stringify(timings)}`);
  });
});
