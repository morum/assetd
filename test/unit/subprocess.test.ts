import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { searchOutputSchema } from "../../src/contracts/json.ts";
import { TEST_ENV, tempProject, writeImage, type TempProject } from "../helpers.ts";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "cli", "main.js");

let project: TempProject | undefined;
afterEach(() => project?.cleanup());

function assetd(cwd: string, ...args: string[]) {
  // Argument array, no shell: identical behavior on Windows and Linux.
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, ...TEST_ENV, NO_COLOR: "1" },
  });
}

describe("built CLI as a subprocess", () => {
  it("keeps stdout pure JSON and uses exit codes", async () => {
    // `npm test` builds first; fail loudly rather than silently skipping.
    if (!fs.existsSync(BIN)) throw new Error(`${BIN} is missing: run \`npm run build\` before this suite.`);
    project = tempProject();
    await writeImage(project, "my assets/rød kiste.png", "#ff0000");
    await writeImage(project, "my assets/blue.png", "#0000ff");

    const idx = assetd(project.root, "index", "my assets", "--json");
    expect(idx.status).toBe(0);
    expect(JSON.parse(idx.stdout).indexed).toBe(2);

    const search = assetd(project.root, "search", "red", "--limit", "1", "--json");
    expect(search.status).toBe(0);
    const doc = searchOutputSchema.parse(JSON.parse(search.stdout));
    expect(doc.results[0]!.path).toBe("my assets/rød kiste.png");

    const missing = assetd(project.root, "inspect", "nope.png", "--json");
    expect(missing.status).toBe(4);
    expect(JSON.parse(missing.stdout).error.code).toBe("PATH_NOT_FOUND");
    expect(missing.stderr).toContain("error:");

    const usage = assetd(project.root);
    expect(usage.status).toBe(2);
  });
});
