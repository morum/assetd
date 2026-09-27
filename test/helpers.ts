import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { run } from "../src/cli/run.ts";

export interface TempProject {
  root: string;
  file(logical: string): string;
  cleanup(): void;
}

export function tempProject(): TempProject {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "assetd-test-")));
  return {
    root,
    file: (logical) => path.join(root, ...logical.split("/")),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
  };
}

/** Writes a solid-color PNG (optionally with a transparent border) at a logical path. */
export async function writeImage(
  project: TempProject,
  logical: string,
  color: string,
  opts: { size?: number; transparentBorder?: boolean; format?: "png" | "jpeg" | "webp" | "gif" } = {},
): Promise<string> {
  const size = opts.size ?? 32;
  const target = project.file(logical);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let img = sharp({ create: { width: size, height: size, channels: 4, background: color } });
  if (opts.transparentBorder) {
    const inner = await sharp({ create: { width: size / 2, height: size / 2, channels: 4, background: color } }).png().toBuffer();
    img = sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([
      { input: inner, left: size / 4, top: size / 4 },
    ]);
  }
  const format = opts.format ?? "png";
  const buffer = await (format === "jpeg" ? img.flatten().jpeg() : format === "webp" ? img.webp() : format === "gif" ? img.gif() : img.png()).toBuffer();
  fs.writeFileSync(target, buffer);
  return target;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

export const TEST_ENV: NodeJS.ProcessEnv = { ASSETD_VISUAL_MODEL: "test-hash", ASSETD_AUDIO_MODEL: "test-audio", ASSETD_OFFLINE: "1" };

/** Runs the CLI in-process with the deterministic test provider. */
export async function cli(cwd: string, ...argv: string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    cwd,
    env: { ...TEST_ENV },
    stderrIsTTY: false,
  });
  let json: unknown;
  if (argv.includes("--json")) json = JSON.parse(stdout);
  return { code, stdout, stderr, json };
}

/** Writes a 16-bit PCM WAV: a sine tone, white noise, or silence. */
export function writeWav(
  project: TempProject,
  logical: string,
  opts: { signal: "sine" | "noise" | "silence"; seconds?: number; sampleRate?: number; channels?: number; frequency?: number },
): string {
  const sampleRate = opts.sampleRate ?? 16_000;
  const channels = opts.channels ?? 1;
  const frames = Math.round((opts.seconds ?? 1) * sampleRate);
  const data = Buffer.alloc(frames * channels * 2);
  let seed = 12345;
  for (let i = 0; i < frames; i++) {
    let v = 0;
    if (opts.signal === "sine") v = 0.5 * Math.sin((2 * Math.PI * (opts.frequency ?? 440) * i) / sampleRate);
    else if (opts.signal === "noise") {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      v = (seed / 0x7fffffff) * 1.6 - 0.8;
    }
    for (let c = 0; c < channels; c++) data.writeInt16LE(Math.round(v * 32767), (i * channels + c) * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  const target = project.file(logical);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.concat([header, data]));
  return target;
}
