import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectOutputSchema, searchOutputSchema, similarOutputSchema, statusOutputSchema, contactSheetOutputSchema } from "../../src/contracts/json.ts";
import { downmix, levels, resampleLinear } from "../../src/embeddings/audio-utils.ts";
import { clapWindows, CLAP_SAMPLE_RATE } from "../../src/embeddings/transformers-provider.ts";
import { ExitCode } from "../../src/core/errors.ts";
import { cli, tempProject, writeImage, writeWav, type TempProject } from "../helpers.ts";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "audio");

let project: TempProject;
beforeEach(async () => {
  project = tempProject();
  writeWav(project, "sfx/white noise.wav", { signal: "noise", seconds: 0.5 });
  writeWav(project, "sfx/beep.wav", { signal: "sine", seconds: 1.5, sampleRate: 44_100, channels: 2 });
  writeWav(project, "sfx/quiet.wav", { signal: "silence", seconds: 0.25 });
  for (const f of fs.readdirSync(FIXTURES)) fs.copyFileSync(path.join(FIXTURES, f), project.file(`sfx/${f}`));
  fs.writeFileSync(project.file("sfx/broken.ogg"), "OggS but not really");
  await writeImage(project, "art/red.png", "#ff0000");
  await writeImage(project, "art/blue.png", "#0000ff");
});
afterEach(() => project.cleanup());

describe("audio indexing", () => {
  it("decodes WAV, OGG, MP3 and FLAC without external binaries and records metadata", async () => {
    const r = await cli(project.root, "index", "sfx", "art", "--json");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ indexed: 8, failed: 1 });
    expect(r.json.failures[0].path).toBe("sfx/broken.ogg");
    expect(r.json.models.map((m: { channel: string }) => m.channel)).toEqual(["visual", "audio"]);

    const beep = inspectOutputSchema.parse((await cli(project.root, "inspect", "sfx/beep.wav", "--json")).json);
    expect(beep).toMatchObject({ kind: "audio", state: "indexed" });
    expect(beep.metadata).toMatchObject({ durationSeconds: 1.5, channels: 2, sampleRate: 44_100, format: "wav" });
    expect(beep.metadata.peakDb).toBeCloseTo(-6, 0);
    expect(beep.embeddings[0]).toMatchObject({ channel: "audio", current: true });

    const ogg = (await cli(project.root, "inspect", "sfx/tone 440.ogg", "--json")).json;
    expect(ogg.metadata.format).toBe("ogg");
    expect(ogg.metadata.durationSeconds).toBeGreaterThan(0.9);
    const mp3 = (await cli(project.root, "inspect", "sfx/noise_burst.mp3", "--json")).json;
    expect(mp3.metadata.format).toBe("mp3");
    const flac = (await cli(project.root, "inspect", "sfx/hum.flac", "--json")).json;
    expect(flac.metadata).toMatchObject({ format: "flac", channels: 2, sampleRate: 16_000 });

    const quiet = (await cli(project.root, "inspect", "sfx/quiet.wav", "--json")).json;
    expect(quiet.metadata.peakDb).toBeNull();

    const status = statusOutputSchema.parse((await cli(project.root, "status", "--json")).json);
    expect(status.types).toEqual({ audio: 6, image: 2 });
    expect(status.stale).toBe(false);
    expect(status.models!.map((m) => m.channel)).toEqual(["visual", "audio"]);
  });
});

describe("audio search", () => {
  beforeEach(async () => {
    await cli(project.root, "index", "sfx", "art");
  });

  it("searches one kind with --type audio", async () => {
    const r = await cli(project.root, "search", "noise", "--type", "audio", "--limit", "3", "--json");
    const doc = searchOutputSchema.parse(r.json);
    expect(doc).toMatchObject({ type: "audio", ranking: "audio+lexical/v1" });
    expect(doc.model.channel).toBe("audio");
    expect(doc.results.every((x) => x.kind === "audio" && x.signals.audio !== undefined && x.signals.visual === undefined)).toBe(true);
    expect(["sfx/white noise.wav", "sfx/noise_burst.mp3"]).toContain(doc.results[0]!.path);
  });

  it("fuses kinds by per-kind z-score when no --type is given", async () => {
    for (const [n, c] of [["green", "#00ff00"], ["yellow", "#ffff00"], ["white", "#ffffff"], ["black", "#000000"], ["purple", "#800080"], ["teal", "#008080"]]) {
      await writeImage(project, `art/${n}.png`, c!);
    }
    await cli(project.root, "index");
    const r = await cli(project.root, "search", "red", "--limit", "8", "--json");
    const doc = searchOutputSchema.parse(r.json);
    expect(doc).toMatchObject({ type: "all", ranking: "zscore-fusion/v2" });
    expect(doc.models!.map((m) => m.channel)).toEqual(["visual", "audio"]);
    expect(new Set(doc.results.map((x) => x.kind))).toEqual(new Set(["image", "audio"]));
    for (const x of doc.results) expect(x.score).toBeCloseTo(x.signals.z! + x.signals.lexical + 4 * x.signals.intent!, 3);
    const asked = searchOutputSchema.parse((await cli(project.root, "search", "red", "sound", "--json")).json);
    expect(asked.results[0]!.kind).toBe("audio");
    expect(asked.results.find((x) => x.kind === "audio")!.signals.intent).toBe(1);
    expect(doc.results[0]!.path).toBe("art/red.png");
  });

  it("keeps single-kind ranking for projects with only one kind indexed", async () => {
    const images = tempProject();
    try {
      await writeImage(images, "a/red.png", "#ff0000");
      await writeImage(images, "a/blue.png", "#0000ff");
      await cli(images.root, "index", "a");
      const doc = searchOutputSchema.parse((await cli(images.root, "search", "red", "--json")).json);
      expect(doc).toMatchObject({ type: "image", ranking: "visual+lexical/v1" });
      expect(doc.results[0]!.signals.visual).toBeDefined();
    } finally {
      images.cleanup();
    }
  });

  it("finds similar sounds, and refuses cross-kind similarity", async () => {
    const r = await cli(project.root, "similar", "sfx/white noise.wav", "--json");
    const doc = similarOutputSchema.parse(r.json);
    expect(doc.type).toBe("audio");
    expect(doc.results.every((x) => x.kind === "audio")).toBe(true);
    expect(doc.results[0]!.path).toBe("sfx/noise_burst.mp3");
    const bad = await cli(project.root, "similar", "sfx/beep.wav", "--type", "image", "--json");
    expect(bad.code).toBe(ExitCode.USAGE_ERROR);
  });

  it("embeds an unindexed reference sound on the fly", async () => {
    const other = tempProject();
    try {
      const ref = writeWav(other, "ref.wav", { signal: "noise", seconds: 0.3, sampleRate: 22_050 });
      const doc = similarOutputSchema.parse((await cli(project.root, "similar", ref, "--json")).json);
      expect(doc.reference.indexed).toBe(false);
      expect(["sfx/white noise.wav", "sfx/noise_burst.mp3"]).toContain(doc.results[0]!.path);
    } finally {
      other.cleanup();
    }
  });

  it("renders sounds as waveforms in contact sheets", async () => {
    const r = await cli(project.root, "contact-sheet", "sfx/beep.wav", "art/red.png", "sfx/broken.ogg", "--json");
    const doc = contactSheetOutputSchema.parse(r.json);
    expect(doc.items[0]!.error).toBeNull();
    expect(doc.items[1]!.error).toBeNull();
    expect(doc.items[2]!.error).not.toBeNull();
    const viaSearch = await cli(project.root, "contact-sheet", "--search", "noise", "--type", "audio", "--limit", "2", "--json");
    expect(viaSearch.json.items).toHaveLength(2);
  });
});

describe("audio utilities", () => {
  it("resamples and downmixes", () => {
    const up = resampleLinear(new Float32Array([0, 1, 0, -1]), 24_000, 48_000);
    expect(up.length).toBe(8);
    expect(up[1]).toBeCloseTo(0.5);
    const down = resampleLinear(new Float32Array(96_000).fill(0.25), 96_000, 48_000);
    expect(down.length).toBe(48_000);
    expect(down[100]).toBeCloseTo(0.25);
    expect(Array.from(downmix([new Float32Array([1, 0]), new Float32Array([0, 1])]))).toEqual([0.5, 0.5]);
    expect(levels(new Float32Array([0.5, -0.5])).peakDb).toBeCloseTo(-6.0, 1);
  });

  it("uses fixed windows for long clips (deterministic)", () => {
    const tenSeconds = 10 * CLAP_SAMPLE_RATE;
    expect(clapWindows(new Float32Array(tenSeconds))).toHaveLength(1);
    expect(clapWindows(new Float32Array(tenSeconds * 2))).toHaveLength(2);
    const long = clapWindows(new Float32Array(tenSeconds * 5));
    expect(long).toHaveLength(3);
    expect(long.every((w) => w.length === tenSeconds)).toBe(true);
  });
});
