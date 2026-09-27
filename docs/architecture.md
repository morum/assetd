# Architecture

assetd is a semantic layer over an existing directory. It never moves, renames,
rewrites or locks assets; everything it derives lives in `.asset-index/` at the
project root (which gets its own `.gitignore` with `*`).

```text
filesystem ─► discovery (.assetignore, defaults) ─► processor registry
                                                     │
                                          ImageProcessor (sharp)
                                           │                 │
                                    metadata          decoded RGB (≤512 px,
                                           │           alpha on white, pixel
                                           │           art upscaled nearest)
                                           │                 │
                                           │      VisualEmbeddingProvider
                                           │      (SigLIP on ONNX Runtime)
                                           ▼                 ▼
                                   SQLite: assets     SQLite: embeddings
                                                (content hash × space)
                                                     │
                         query text ─► text tower ─► cosine scan + path words ─► CLI / JSON
```

## Decisions

### Runtime: pure Node.js, no Python

Inference uses **transformers.js 4 → onnxruntime-node** on CPU. ONNX Runtime
ships prebuilt binaries for `win32-x64`, `linux-x64` and `linux-arm64` (and
macOS) inside the npm package; no compiler, Python, CUDA, Docker or WSL is
involved. Image decoding and the contact sheet use **sharp**, which installs a
prebuilt libvips per platform through optional dependencies. Storage is Node's
built-in **`node:sqlite`** (Node ≥ 22.13), so there is no native database
addon at all.

A Python worker was considered and rejected: the ONNX path gives the same model
quality, keeps one process and one install step, and avoids interpreter
discovery (`python` vs `python3` vs `py`) on Windows.

### Model: SigLIP base, int8 ONNX

Default: `Xenova/siglip-base-patch16-224`, `q8` weights (vision 95 MB + text
106 MB), 768-d joint image–text space. On 1,361 blind-named CC0 game assets
it finds a relevant file in the top 5 for 85% of queries, against 66–68% for
CLIP B/32 and B/16; fp32 weights and larger variants are within a few points
and much slower (full tables and method: [evaluation.md](evaluation.md)).
`siglip-large` is available for the last few points of quality.
Alternatives are configuration, not code: `clip-vit-b32`, `dtype: "fp32"`, or
any transformers.js-layout export of the same families (`"siglip:<org>/<repo>"`).

The two towers load independently: a text search only loads the text encoder.

### Audio: CLAP on ONNX, WASM decoders

Sounds are decoded by `audio-decode` (WebAssembly decoders for WAV, Ogg
Vorbis/Opus, MP3, FLAC, M4A/AAC, AIFF): no FFmpeg, no native addon, identical
on Windows and Linux. The processor downmixes to mono, records duration,
channels, sample rate, average bitrate and peak/RMS level (dBFS), and hands
the samples to the audio provider.

The audio provider is CLAP (LAION `larger_clap_general`, int8, the best of
four configurations in [evaluation.md](evaluation.md)) through the same
transformers.js/ONNX path as SigLIP. CLAP expects 48 kHz and at most 10 s; for longer input its feature
extractor would take a **random** crop, which would make indexing
non-deterministic. assetd therefore resamples to 48 kHz itself and embeds fixed
windows — the whole clip up to 10 s, else start and end, else start, middle and
end — and averages the normalized vectors. Windows go through the model four
at a time (~2.9× faster indexing than one per call). Decoding keeps the whole clip in
memory; very long music files cost memory proportional to their length.

The audio model is created lazily: an image-only project never downloads it,
and a text search skips any kind with no indexed assets.

### 3D models

GLB/glTF are read with `@gltf-transform/core` (pure JS) plus the Draco and
meshopt WASM decoders; OBJ/MTL with a small built-in parser. assetd reads the
container and external files itself, so a missing texture becomes a
`missingResources` entry (with a placeholder) instead of failing the model.
Both loaders produce the same format-neutral scene (world-space triangles, UVs,
vertex colors, base color and texture per primitive): metadata is derived from
it, and preview rendering will draw it. Changes to a model's external
`.bin`/texture files are not tracked yet: re-index after editing only those.

### Searching several kinds

Each kind is scored in its own space (images: SigLIP, sounds: CLAP). With
`--type` the ranking is exactly the single-kind one. Without it, when more than
one kind has assets, each kind's scores for the query are standardized over
that kind's candidates (z-score), the filename signal is added in z units
(identical for every kind), and results merge on the sum. Raw cosines from two models
are on unrelated scales and are never compared. The z of a kind with `n`
candidates is shrunk by `n / (n + 10)`: with two images every query yields ±1,
which would otherwise let a nearly empty kind dominate.

### Storage: one SQLite file, brute-force cosine

- `assets` — one row per logical path: stat info, content hash, metadata JSON,
  processor id/version, state (`indexed`/`failed`), error.
- `embeddings` — float32 little-endian BLOBs keyed by `(content_hash, space_id)`.
  Identical files share one vector; different models never mix (the space id
  encodes family, repo, dtype and preprocessing revision).
- `query_cache` — recent text-query vectors per space (repeat queries skip
  loading the model entirely).
- `roots`, `meta`; `PRAGMA user_version` is the schema version.

Search loads one space's vectors into a contiguous `Float32Array` and scans it.
Measured on a 28-thread desktop: 20 000 × 768 vectors load in ~140 ms and score
in ~25 ms; 50 000 in ~330 ms + ~60 ms. That is below model-load time, so an ANN
index or a vector extension would add install complexity for no visible gain at
the target scale. If it ever matters, the next step is a memory-mapped flat
matrix file next to the database; the `IndexStore` boundary keeps that local.

WAL mode, `busy_timeout`, per-batch transactions and a PID lock file for
writers (`INDEX_BUSY` when another live run holds it; a dead PID's lock is
taken over) make interrupted or concurrent runs safe.

### Incremental indexing

1. Discover files under the roots; `(size, mtime)` equal to the stored row
   **and** same processor version **and** a vector in the active space → unchanged.
2. Otherwise read the file once (no open handle is kept — Windows locks),
   hash it; identical content → only refresh stat info.
3. Reuse a vector when another asset already has the same content hash.
4. Otherwise process + embed in batches (16); a failing batch is retried file
   by file so one bad asset never takes others down.
5. Remove rows for files gone from the scanned roots — never below a directory
   that could not be read in this run. Orphan vectors are pruned.

Changing the model or the processor version therefore reprocesses exactly what
is affected, and nothing else.

### Paths

Native paths are only used to touch the filesystem. Logical paths
(project-relative, `/`-separated, exact code points from `readdir`) are the
identity and the only form printed. User input is accepted relative to the cwd,
absolute, or logical with either separator; lookups fall back to a
case-folded, NFC-normalized key when unambiguous, so agents get the same
behavior on case-insensitive Windows and case-sensitive Linux. Ignore patterns
are matched case-insensitively on every OS. Paths are built with `path.join`/
`path.relative` only; logical/native conversion is unit-tested against both
`path.win32` and `path.posix` (drive letters, UNC, spaces, Unicode).

### Processors

`AssetProcessor` (`src/processors/types.ts`) declares an id, version, kind,
channels, extensions, and returns metadata plus **embedding requests** per
channel. The indexer groups requests by channel (`visual`, `audio`) and routes
them to that channel's provider; an asset is up to date only when every channel
its processor produces has a current vector. A new asset type is a new processor registered in
`createProcessorRegistry`; the engine does not change (a test registers a
project-specific processor to prove it). Future channels (`audio`, `text`,
`geometry`) are separate spaces; multimodal ranking will use per-channel
candidate lists merged by reciprocal-rank fusion, never raw cosine comparison
across spaces.

## External runtime dependencies

| Dependency | Why | Windows | Linux | How it is found | If unavailable |
|---|---|---|---|---|---|
| Node.js ≥ 22.13 | runtime, `node:sqlite` | ✓ | ✓ | the user's `node` | install fails (`engines`) |
| sharp (libvips) | decode images, contact sheets | prebuilt `win32-x64` | prebuilt `linux-x64/arm64` (glibc, musl) | npm optional deps | install error from sharp |
| onnxruntime-node | run the models | bundled `win32-x64` | bundled `linux-x64/arm64` | inside the npm package | install error |
| audio-decode (WASM) | decode sounds | ✓ (WASM) | ✓ (WASM) | npm package | the file is recorded as failed |
| Model weights | embeddings | ✓ | ✓ | downloaded once from Hugging Face to the model cache (SigLIP ~200 MB; CLAP only when sounds exist) | exit 6 with instructions |

No other binary is used. FFmpeg, Blender, Python, CUDA, Docker, shells and
symlinks are not required. onnxruntime-node has an optional install script that
can fetch CUDA provider binaries; it is not needed (set
`ONNXRUNTIME_NODE_INSTALL=skip` to make that explicit).

### Model cache

Shared by all projects on the machine:

- `ASSETD_MODEL_DIR` if set
- Windows: `%LOCALAPPDATA%\assetd\models`
- Linux: `$XDG_CACHE_HOME/assetd/models`, else `~/.cache/assetd/models`
- macOS: `~/Library/Caches/assetd/models`

Downloads are written to a temp file and renamed (interrupted downloads leave
nothing half-written). `assetd models pull` prefetches; `ASSETD_OFFLINE=1`
forbids network access afterwards.

## Latency (measured, CPU only, no daemon)

Linux, Node 26, 28-thread desktop, 380-image project:

| Command | Wall time |
|---|---:|
| `assetd --version` | ~70 ms |
| `assetd status --json` (with stale check) | ~110 ms |
| `assetd inspect <path> --json` | ~110 ms |
| `assetd search "<new query>" --json` | ~550 ms (text tower load ~300 ms, embed ~50 ms) |
| `assetd search "<repeated query>" --json` | ~90–125 ms (query cache) |
| `assetd similar <indexed path> --json` | ~125 ms (no model load) |
| `assetd index` with nothing changed | ~120 ms |
| `assetd index` first run, 380 icons | ~26 s (~15 images/s; vision tower dominates) |

Model loading dominates a cold search, and it is well under a second, so a
persistent process is not justified. The query cache removes it for repeated
queries. The table was measured on Linux. On GitHub's `windows-latest` runner
(few vCPUs, cold disk) the same end-to-end flow passes — index, text search,
similar, inspect with `\`-separated input, contact sheet — with a cold
`assetd search --json` at ~0.9 s wall time; it has not been profiled on a
Windows workstation.

## Directory structure

```text
scripts/eval/      retrieval benchmark on labeled CC0 game assets (Kenney)
src/
  cli/            argument parsing, output (JSON/human), one module per command
  contracts/      Zod schemas of every --json document
  core/           paths, config, project discovery, ignore rules, discovery, errors
  processors/     AssetProcessor API, registry, image processor
  embeddings/     provider API, SigLIP/CLIP (transformers.js), test provider, model cache
  storage/        SQLite index store, writer lock
  indexing/       incremental index orchestration
  search/         vector scan, ranking, search services
  contact-sheet/  grid rendering
test/unit/        fast tests, deterministic "test-hash" provider, generated fixtures
test/model/       real-model integration test (needs ASSETD_MODEL_DIR)
skills/assetd/    optional agent skill
```
