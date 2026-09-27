import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AssetdError } from "./errors.ts";

export const CONFIG_FILE_NAME = "assetd.json";

const processorsSchema = z
  .object({
    image: z.boolean().default(true),
    audio: z.boolean().default(true),
    model3d: z.boolean().default(false),
    video: z.boolean().default(false),
    text: z.boolean().default(false),
  })
  .strict();

const modelsSchema = z
  .object({
    /** Visual embedding model: a preset name (see embeddings/presets.ts) or a Hugging Face repo id. */
    visual: z.string().min(1).default("siglip-base"),
    /** ONNX weight variant. "q8" is the small default; "fp32" is the most accurate. */
    dtype: z.enum(["q8", "fp16", "fp32"]).optional(),
    /** Audio embedding model: a preset name or "clap:<org>/<repo>". */
    audio: z.string().min(1).default("clap-general"),
    audioDtype: z.enum(["q8", "fp16", "fp32"]).optional(),
  })
  .strict();

export const configSchema = z
  .object({
    $schema: z.string().optional(),
    /** Logical (project-relative) directories scanned when `assetd index` gets no argument. */
    roots: z.array(z.string().min(1)).optional(),
    /** Extra ignore patterns (gitignore syntax), added to .assetignore. */
    ignore: z.array(z.string()).default([]),
    /** Also apply the project's root .gitignore. */
    respectGitignore: z.boolean().default(false),
    /** Apply built-in ignores (VCS folders, node_modules, engine caches). */
    defaultIgnores: z.boolean().default(true),
    /** Files larger than this are recorded as failed instead of being decoded. */
    maxFileSizeMb: z.number().positive().default(256),
    processors: processorsSchema.default({ image: true, audio: true, model3d: false, video: false, text: false }),
    models: modelsSchema.default({ visual: "siglip-base", audio: "clap-general" }),
  })
  .strict();

export type AssetdConfig = z.infer<typeof configSchema>;

export function defaultConfig(): AssetdConfig {
  return configSchema.parse({});
}

/** Loads `assetd.json` from the project root; zero-config when absent. */
export function loadConfig(projectRoot: string, env: NodeJS.ProcessEnv = process.env): AssetdConfig {
  const file = path.join(projectRoot, CONFIG_FILE_NAME);
  let config: AssetdConfig;
  let raw: string | undefined;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AssetdError("USAGE_ERROR", `Cannot read ${CONFIG_FILE_NAME}: ${(err as Error).message}`);
    }
  }
  if (raw === undefined) {
    config = defaultConfig();
  } else {
    let json: unknown;
    try {
      json = JSON.parse(raw.replace(/^﻿/, ""));
    } catch (err) {
      throw new AssetdError("USAGE_ERROR", `Invalid JSON in ${CONFIG_FILE_NAME}: ${(err as Error).message}`);
    }
    const parsed = configSchema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      throw new AssetdError("USAGE_ERROR", `Invalid ${CONFIG_FILE_NAME}: ${issues.join("; ")}`, { issues });
    }
    config = parsed.data;
  }
  // Environment overrides are mainly for tests and CI.
  if (env.ASSETD_VISUAL_MODEL) config.models.visual = env.ASSETD_VISUAL_MODEL;
  if (env.ASSETD_AUDIO_MODEL) config.models.audio = env.ASSETD_AUDIO_MODEL;
  if (env.ASSETD_MODEL_DTYPE) {
    const dtype = z.enum(["q8", "fp16", "fp32"]).safeParse(env.ASSETD_MODEL_DTYPE);
    if (!dtype.success) throw new AssetdError("USAGE_ERROR", `Invalid ASSETD_MODEL_DTYPE: ${env.ASSETD_MODEL_DTYPE}`);
    config.models.dtype = dtype.data;
  }
  return config;
}
