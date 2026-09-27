/**
 * Retrieval evaluation on real, labeled game assets (Kenney CC0 packs).
 *
 *   node scripts/eval/eval.ts fetch
 *   node scripts/eval/eval.ts run --kind image --models siglip-base,clip-vit-b32@fp32
 *
 * Files are copied under meaningless names, so lexical ranking contributes
 * nothing and only the embedding model is measured. Data, indexes and results
 * live in .eval-data/ (git-ignored). Weights come from the normal model cache
 * (ASSETD_MODEL_DIR or the platform default).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { defaultConfig, type AssetdConfig } from "../../src/core/config.ts";
import { createIgnoreMatcher } from "../../src/core/ignore.ts";
import type { AssetKind } from "../../src/core/types.ts";
import { runIndex } from "../../src/indexing/indexer.ts";
import { createProcessorRegistry } from "../../src/processors/registry.ts";
import { searchByText } from "../../src/search/search-service.ts";
import { IndexStore } from "../../src/storage/index-store.ts";
import { createProviders } from "../../src/embeddings/registry.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const DATA = path.join(REPO, ".eval-data");

interface Pack {
  id: string;
  kind: AssetKind;
  url: string;
  sha256: string;
  include: string[];
  exclude?: string;
}

const MEDIA = { image: /\.(png|jpe?g|webp|gif|svg)$/i, audio: /\.(wav|ogg|mp3|flac)$/i } as Record<string, RegExp>;

function packs(): Pack[] {
  return (JSON.parse(fs.readFileSync(path.join(HERE, "datasets.json"), "utf8")) as { packs: Pack[] }).packs;
}

async function fetchPacks(): Promise<void> {
  for (const pack of packs()) {
    const zipPath = path.join(DATA, "downloads", `${pack.id}.zip`);
    if (!fs.existsSync(zipPath)) {
      process.stderr.write(`downloading ${pack.id}...\n`);
      const res = await fetch(pack.url);
      if (!res.ok) throw new Error(`${pack.url}: HTTP ${res.status}`);
      fs.mkdirSync(path.dirname(zipPath), { recursive: true });
      fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
    }
    const zip = fs.readFileSync(zipPath);
    const digest = createHash("sha256").update(zip).digest("hex");
    if (digest !== pack.sha256) throw new Error(`${pack.id}: sha256 mismatch (${digest})`);
    const exclude = pack.exclude ? new RegExp(pack.exclude, "i") : null;
    const files = unzipSync(new Uint8Array(zip), {
      filter: (f) => MEDIA[pack.kind]!.test(f.name) && pack.include.some((p) => f.name.startsWith(p)) && !(exclude && exclude.test(f.name)),
    });
    let n = 0;
    for (const [name, data] of Object.entries(files)) {
      const target = path.join(DATA, "corpus", pack.kind, pack.id, ...name.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      n++;
    }
    process.stderr.write(`${pack.id}: ${n} files\n`);
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out.sort();
}

interface Corpus {
  root: string;
  /** Obfuscated logical path -> original basenames (duplicates collapse). */
  labels: Map<string, string[]>;
}

/**
 * Copies the corpus under content-hash names into .eval-data/work/<kind>. The
 * directory and its per-model indexes persist, so re-running only embeds what
 * is new (the normal incremental indexer does the work).
 */
function buildCorpus(kind: AssetKind): Corpus {
  const source = path.join(DATA, "corpus", kind);
  if (!fs.existsSync(source)) throw new Error(`No ${kind} corpus: run \`node scripts/eval/eval.ts fetch\` first`);
  const root = path.join(DATA, "work", kind);
  fs.mkdirSync(root, { recursive: true });
  const labels = new Map<string, string[]>();
  for (const file of listFiles(source)) {
    const data = fs.readFileSync(file);
    const logical = `c/${createHash("sha256").update(data).digest("hex").slice(0, 16)}${path.extname(file).toLowerCase()}`;
    const base = path.basename(file, path.extname(file));
    if (!labels.has(logical)) {
      const target = path.join(root, ...logical.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) fs.writeFileSync(target, data);
      labels.set(logical, []);
    }
    labels.get(logical)!.push(base);
  }
  return { root, labels };
}

interface QueryResult {
  query: string;
  relevant: number;
  firstRank: number | null;
  top: string[];
}

function configFor(kind: AssetKind, spec: string): AssetdConfig {
  const [name, dtype] = spec.split("@");
  const config = defaultConfig();
  config.processors = { image: kind === "image", audio: kind === "audio", model3d: false, video: false, text: false };
  const models = config.models as Record<string, unknown>;
  models[kind === "image" ? "visual" : "audio"] = name;
  if (dtype) models[kind === "image" ? "dtype" : "audioDtype"] = dtype;
  return config;
}

function resultFile(kind: AssetKind, spec: string): string {
  return path.join(DATA, "results", `${kind}-${spec.replace(/[^\w.@-]/g, "_")}.json`);
}

async function evaluate(kind: AssetKind, spec: string, corpus: Corpus, queries: [string, string][]) {
  const config = configFor(kind, spec);
  const providers = createProviders(config);
  const provider = kind === "image" ? providers.visual : providers.audio!;
  const store = IndexStore.open(path.join(corpus.root, ".asset-index", `${spec.replace(/[^\w.-]/g, "_")}.db`), { create: true });
  try {
    const t0 = performance.now();
    const stats = await runIndex({
      projectRoot: corpus.root,
      roots: ["c"],
      store,
      registry: createProcessorRegistry(config),
      providers,
      ignore: createIgnoreMatcher(corpus.root, config),
      maxFileSizeBytes: 64 * 1048576,
    });
    const indexMs = performance.now() - t0;
    if (stats.failed > 0) process.stderr.write(`  ${stats.failed} failures, e.g. ${stats.failures[0]?.error}\n`);
    await provider.embedTexts(["warm up"]);
    const results: QueryResult[] = [];
    let queryMs = 0;
    for (const [query, pattern] of queries) {
      const re = new RegExp(pattern, "i");
      const relevant = [...corpus.labels.values()].filter((names) => names.some((n) => re.test(n))).length;
        // Timed on the model directly: the search itself may hit the query cache.
      const t = performance.now();
      await provider.embedTexts([query]);
      queryMs += performance.now() - t;
      const outcome = await searchByText(store, provider, query, { kind, limit: 50 });
      const names = outcome.hits.map((h) => corpus.labels.get(h.path) ?? []);
      const idx = names.findIndex((ns) => ns.some((n) => re.test(n)));
      results.push({ query, relevant, firstRank: idx >= 0 ? idx + 1 : null, top: names.slice(0, 5).map((ns) => ns[0] ?? "?") });
    }
    const n = results.length;
    const hit = (k: number) => results.filter((r) => r.firstRank !== null && r.firstRank <= k).length / n;
    const mrr = results.reduce((s, r) => s + (r.firstRank !== null && r.firstRank <= 10 ? 1 / r.firstRank : 0), 0) / n;
    // Throughput is only measured when this run embedded something; reruns reuse the earlier figure.
    let assetsPerSecond: number | null = stats.indexed >= 50 ? Math.round((stats.indexed / indexMs) * 10_000) / 10 : null;
    if (assetsPerSecond === null && fs.existsSync(resultFile(kind, spec))) {
      assetsPerSecond = (JSON.parse(fs.readFileSync(resultFile(kind, spec), "utf8")) as { assetsPerSecond: number | null }).assetsPerSecond;
    }
    return {
      model: spec,
      assets: stats.indexed + stats.unchanged,
      assetsPerSecond,
      queryMs: Math.round(queryMs / n),
      hit1: hit(1),
      hit5: hit(5),
      hit10: hit(10),
      mrr10: Math.round(mrr * 1000) / 1000,
      results,
    };
  } finally {
    store.close();
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { kind: { type: "string", default: "image" }, models: { type: "string" }, queries: { type: "string" } },
  });
  if (positionals[0] === "fetch") return fetchPacks();
  if (positionals[0] !== "run") throw new Error("usage: eval.ts fetch | run --kind image|audio --models a,b@fp32");
  const kind = values.kind as AssetKind;
  const models = (values.models ?? (kind === "image" ? "siglip-base" : "clap-htsat-unfused")).split(",");
  const queryFile = values.queries ?? path.join(HERE, `${kind}-queries.json`);
  const queries = (JSON.parse(fs.readFileSync(queryFile, "utf8")) as { queries: [string, string][] }).queries;
  const corpus = buildCorpus(kind);
  process.stderr.write(`${kind} corpus: ${corpus.labels.size} unique files, ${queries.length} queries\n`);
  const outDir = path.join(DATA, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const reports: Awaited<ReturnType<typeof evaluate>>[] = [];
  const errors: string[] = [];
  for (const spec of models) {
    process.stderr.write(`evaluating ${spec}...\n`);
    try {
      const report = await evaluate(kind, spec, corpus, queries);
      reports.push(report);
      // Saved per model so a later failure never loses finished work.
      fs.writeFileSync(resultFile(kind, spec), JSON.stringify({ kind, corpusFiles: corpus.labels.size, ...report }, null, 2));
    } catch (err) {
      errors.push(`${spec}: ${err instanceof Error ? err.message : String(err)}`);
      process.stderr.write(`  failed: ${errors[errors.length - 1]}\n`);
    }
  }
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines = [
    `| Model | Hit@1 | Hit@5 | Hit@10 | MRR@10 | Index (assets/s) | Query (ms, warm) |`,
    `|---|---:|---:|---:|---:|---:|---:|`,
    ...reports.map((r) => `| ${r.model} | ${pct(r.hit1)} | ${pct(r.hit5)} | ${pct(r.hit10)} | ${r.mrr10} | ${r.assetsPerSecond ?? "-"} | ${r.queryMs} |`),
  ];
  const misses = reports.map((r) => `${r.model} misses@5: ${r.results.filter((q) => q.firstRank === null || q.firstRank > 5).map((q) => `"${q.query}"→${q.top.slice(0, 3).join(",")}`).join("; ")}`);
  process.stdout.write(`${lines.join("\n")}\n\n${misses.join("\n\n")}\n${errors.length ? `\nFailed: ${errors.join("; ")}\n` : ""}`);
  if (errors.length) process.exitCode = 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
