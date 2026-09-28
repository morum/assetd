# Architecture

assetd is a semantic layer over an existing directory. It never moves, renames,
rewrites or locks assets; everything it derives lives in `.asset-index/` at the
project root (which gets its own `.gitignore` with `*`).

```text
filesystem ─► discovery (.assetignore, defaults) ─► processor registry
                                                        │
        ┌───────────────────────────────┬───────────────┴───────────────────┐
  ImageProcessor (sharp)        AudioProcessor (WASM decoders)   Model3DProcessor (glTF/OBJ/FBX)
        │                               │                                   │
  metadata + RGB ≤512 px          metadata + mono PCM          metadata + software renders
        │                               │                                   │
        └──── visual channel ───────────┼──────────── visual channel ───────┘
              SigLIP (ONNX Runtime)     │ audio channel: CLAP (ONNX Runtime)
                        │               │               │
                        ▼               ▼               ▼
        SQLite: assets · embeddings (content hash × space) · previews on disk
                                        │
   query text ─► text tower(s) ─► per-kind cosine scan + path words
                                 ─► single kind, or z-score fusion across kinds ─► CLI / JSON
```

## Decisions

### Runtime: pure Node.js, no Python

Inference uses **transformers.js 4 → onnxruntime-node** on CPU. ONNX Runtime
ships prebuilt binaries for `win32-x64`, `linux-x64` and `linux-arm64` (and
macOS) inside the npm package; no compiler, Python, CUDA, Docker or WSL is
involved. Image decoding and the contact sheet use **sharp**, which installs a
prebuilt libvips per platform through optional dependencies. Sounds, Draco and
meshopt use WebAssembly decoders. Storage is Node's built-in **`node:sqlite`**
(Node ≥ 22.13), so there is no native database addon at all.

A Python worker was considered and rejected: the ONNX path gives the same model
quality, keeps one process and one install step, and avoids interpreter
discovery (`python` vs `python3` vs `py`) on Windows.

Heavy modules (the ML runtime, three.js, audio decoders) are imported on first
use, so `--version`, `status` and `inspect` stay around 0.1 s.

### Images: SigLIP base, int8 ONNX

Default: `Xenova/siglip-base-patch16-224`, `q8` weights (vision 95 MB + text
106 MB), 768-d joint image–text space. On 1,361 blind-named CC0 game assets
it finds a relevant file in the top 5 for 85% of queries, against 66–68% for
CLIP B/32 and B/16; fp32 weights and larger variants are within a few points
and much slower (tables and method: [evaluation.md](evaluation.md)).
`siglip-large` is available for the last few points of quality. Alternatives are
configuration, not code: `clip-vit-b32`, `dtype: "fp32"`, or any
transformers.js-layout export of the same families (`"siglip:<org>/<repo>"`).

Images are flattened on white, pixel art is upscaled with nearest-neighbour,
and large images are reduced to 512 px before embedding. The text and vision
towers load independently: a text search only loads the text encoder.

### Audio: CLAP on ONNX, WASM decoders

Sounds are decoded by `audio-decode` (WebAssembly decoders for WAV, Ogg
Vorbis/Opus, MP3, FLAC, M4A/AAC, AIFF): no FFmpeg, no native addon, identical
on Windows and Linux. The processor downmixes to mono, records duration,
channels, sample rate, average bitrate and peak/RMS level (dBFS), and hands
the samples to the audio provider.

The audio provider is CLAP (LAION `larger_clap_general`, int8, the best of four
configurations in [evaluation.md](evaluation.md#audio)) through the same
transformers.js/ONNX path as SigLIP. CLAP expects 48 kHz and at most 10 s; for
longer input its feature extractor would take a **random** crop, which would
make indexing non-deterministic. assetd therefore resamples to 48 kHz itself and
embeds fixed windows — the whole clip up to 10 s, else start and end, else
start, middle and end — and averages the normalized vectors. Windows go through
the model four at a time (~2.9× faster indexing than one per call). Decoding
keeps the whole clip in memory; very long music files cost memory proportional
to their length.

The audio model is created lazily: a project without sounds never downloads it,
and a text search skips any kind with no indexed assets.

### 3D models: parse, render in software, embed the renders

**Reading.** GLB/glTF are read with `@gltf-transform/core` (pure JS) plus the
Draco and meshopt WASM decoders; OBJ/MTL with a small built-in parser; FBX
(binary and ASCII, 6.1+) with three.js's pure-JS `FBXLoader`, imported only when
a project has FBX files. assetd reads containers and external files itself, so a
missing texture becomes a `missingResources` entry (with a placeholder) instead
of failing the model; a missing geometry buffer does fail it. All loaders
produce the same format-neutral scene — world-space triangles, UVs, vertex
colors, base color and texture per material — from which metadata is derived
and which the renderer draws.

Around the FBX loader assetd:

- captures texture references instead of letting three.js load images (which
  needs a DOM) and resolves them itself: the path as written, else the bare
  file name next to the model and in `Textures/` — FBX often stores the
  exporting machine's absolute path (`C:\Users\artist\...`); embedded textures
  are read from the loader's `blob:` URLs;
- re-indents ASCII FBX by brace depth and drops dangling array commas before
  parsing: three.js's text parser relies on exact tab indentation and on array
  lines not ending in ",", and some exporters break both (it silently corrupted
  UVs and material assignment in two Kenney kits);
- converts geometry to meters from the file's `UnitScaleFactor` (as Unity's "Use
  File Scale" does; Z-up files are rotated by the loader) and merges the
  per-polygon material groups the loader emits into one primitive per material.

**Rendering.** A small software rasterizer (`src/render/rasterizer.ts`, pure
TypeScript) draws the scene with an orthographic camera fitted to the model, a
z-buffer, double-sided Lambert shading (tolerates flipped normals), base color
× texture × vertex color, alpha cut-outs, 2× supersampling and a white
background, in ~10 ms per 256 px view. It needs no GPU, OpenGL, Blender or
native binary. Its output is bit-identical across platforms: a test pins the
SHA-256 of a render and CI checks it on Linux and Windows.

**Embedding.** Two opposite perspective views (configurable: 1, 2 or 4) are
embedded with SigLIP and averaged. Models therefore live in the **same visual
space as images**: `similar model.glb --type image` and
`similar icon.png --type model3d` compare them directly. On 709 CC0 models,
Hit@5 is 90% / 92% / 95% for 1 / 2 / 4 views at 12.9 / 5.5 / 2.8 models/s
([evaluation.md](evaluation.md#3d-models)); the seven fixed views of the
original plan were both the slowest and the least accurate. The view set is part
of the processor version, so changing it re-embeds exactly the 3D models.

**Previews.** The first view is saved as the model's preview
(`.asset-index/previews/<contentHash>/preview.png`), shared by identical files
and pruned with the index, for `inspect` and contact sheets.

Limitation: changes to a model's external `.bin`/texture files are not tracked;
a model is re-processed only when its own file changes.

### Searching several kinds

Each kind is scored in its own space: images and 3D renders with SigLIP, sounds
with CLAP. With `--type` the ranking is exactly the single-kind one
(`score = cosine + 0.05 × filename-word overlap`).

Without `--type`, when more than one kind has assets, raw cosines are never
compared across kinds. Each kind's semantic scores for the query are
standardized over that kind's candidates (z-score); the filename signal and an
explicit-intent signal ("the sound of coins", "a sword icon", "a 3D model of a
chair") are added in z units, identical for every kind; results merge on the
sum (`zscore-fusion/v2`). Images and 3D models are standardized separately even
though they share a space, because renders and pictures score on different
scales. The z of a kind with `n` candidates is shrunk by `n / (n + 10)`: with two
images every query yields ±1, which would otherwise let a nearly empty kind
dominate. A fixed filename bonus in cosine units was tried first and measured
as unfair: 0.05 is 2.4–2.8 standard deviations of SigLIP scores but only
0.6–0.7 for CLAP ([evaluation.md](evaluation.md#mixed-image--audio-search)).

### Storage: one SQLite file, brute-force cosine

- `assets` — one row per logical path: stat info, content hash, metadata JSON,
  processor id/version, state (`indexed`/`failed`), error.
- `embeddings` — float32 little-endian BLOBs keyed by `(content_hash, space_id)`.
  Identical files share one vector; different models never mix (the space id
  encodes family, repo, dtype and preprocessing revision).
- `query_cache` — recent text-query vectors per space (repeat queries skip
  loading the model entirely).
- `roots`, `meta`; `PRAGMA user_version` is the schema version.
- Derived previews are PNG files under `.asset-index/previews/`, not rows.

Search loads one space's vectors for one kind into a contiguous `Float32Array`
and scans it. Measured on a 28-thread desktop: 20 000 × 768 vectors load in
~140 ms and score in ~25 ms; 50 000 in ~330 ms + ~60 ms. That is below
model-load time, so an ANN index or a vector extension would add install
complexity for no visible gain at the target scale. If it ever matters, the next
step is a memory-mapped flat matrix file next to the database; the `IndexStore`
boundary keeps that local.

WAL mode, `busy_timeout`, per-batch transactions and a PID lock file for
writers (`INDEX_BUSY` when another live run holds it; a dead PID's lock is
taken over) make interrupted or concurrent runs safe. Roots are recorded before
processing, so `assetd index` after an interrupted run resumes the same scope.

### Incremental indexing

1. Discover files under the roots; `(size, mtime)` equal to the stored row
   **and** same processor version **and** a current vector for every channel
   the processor produces → unchanged.
2. Otherwise read the file once (no open handle is kept — Windows locks),
   hash it; identical content → only refresh stat info.
3. Reuse vectors when another asset already has the same content hash.
4. Otherwise process + embed in batches (16), grouped by channel; a failing
   batch is retried file by file so one bad asset never takes others down.
5. Remove rows for files gone from the scanned roots — but never below a
   directory that exists and could not be read in this run (permissions,
   locks); a root that no longer exists is forgotten. Orphan vectors and
   previews are pruned.

Changing a model, the processor version or the 3D view set therefore
reprocesses exactly what is affected, and nothing else.

### Paths

Native paths are only used to touch the filesystem. Logical paths
(project-relative, `/`-separated, exact code points from `readdir`) are the
identity and the only form printed. User input is accepted relative to the cwd,
absolute, or logical with either separator; lookups fall back to a
case-folded, NFC-normalized key when unambiguous, and a path typed with the
wrong letter case on a case-insensitive filesystem (Windows) is reported with
its on-disk spelling (both sides canonicalized with `realpath`). Ignore patterns
are matched case-insensitively on every OS. Paths are built with `path.join`/
`path.relative` only; logical/native conversion is unit-tested against both
`path.win32` and `path.posix` (drive letters, UNC, spaces, Unicode).

### Processors and channels

`AssetProcessor` (`src/processors/types.ts`) declares an id, version, kind,
channels, extensions, and returns metadata, **embedding requests** per channel
(one image, several views to average, or an audio clip) and optional preview
images. The indexer groups requests by channel (`visual`, `audio`) and routes
them to that channel's provider. A new asset type is a new processor registered
in `createProcessorRegistry`; the engine does not change (a test registers a
project-specific processor to prove it). A new modality with its own model
(e.g. `text`) is a new channel and provider, and joins the cross-kind fusion
above without comparing its raw scores to anyone else's.

## External runtime dependencies

| Dependency | Why | Windows | Linux | How it is found | If unavailable |
|---|---|---|---|---|---|
| Node.js ≥ 22.13 | runtime, `node:sqlite` | ✓ | ✓ | the user's `node` | install fails (`engines`) |
| sharp (libvips) | decode images, renders, contact sheets | prebuilt `win32-x64` | prebuilt `linux-x64/arm64` (glibc, musl) | npm optional deps | install error from sharp |
| onnxruntime-node | run the models | bundled `win32-x64` | bundled `linux-x64/arm64` | inside the npm package | install error |
| audio-decode | decode sounds | WASM | WASM | npm package | the file is recorded as failed |
| @gltf-transform, draco3dgltf, meshoptimizer | read glTF (incl. compressed) | JS + WASM | JS + WASM | npm packages | the file is recorded as failed |
| three (FBXLoader only) | read FBX | JS | JS | npm package, imported on demand | the file is recorded as failed |
| Model weights | embeddings | ✓ | ✓ | downloaded once from Hugging Face to the model cache (SigLIP ~200 MB; CLAP ~200 MB, only when sounds exist) | exit 6 with instructions |

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
nothing half-written). `assetd models pull` prefetches every enabled model;
`ASSETD_OFFLINE=1` forbids network access afterwards.

## Performance (measured, CPU only, no daemon)

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

First-time indexing throughput on the same machine: ~12 images/s, ~5.7 short
sounds/s, ~5.5 3D models/s with the default two views (vision and audio towers
dominate). Model loading dominates a cold search and is well under a second, so
a persistent process is not justified; the query cache removes it for repeated
queries.

On GitHub's `windows-latest` runner (few vCPUs, cold disk) the same end-to-end
flow passes — index, text search, similar, inspect with `\`-separated input,
contact sheet, 3D search — with a cold `assetd search --json` at ~0.9 s wall
time; it has not been profiled on a Windows workstation.

## Directory structure

```text
src/
  cli/              argument parsing, output (JSON/human), one module per command
  contracts/        Zod schemas of every --json document
  core/             paths, config, project discovery, ignore rules, discovery, errors
  processors/       AssetProcessor API and registry
    image/          sharp: metadata and decoding
    audio/          WASM decoders: metadata and PCM
    model3d/        glTF, OBJ and FBX loaders, format-neutral scene, processor
  render/           software rasterizer for 3D previews
  embeddings/       provider API, SigLIP/CLIP and CLAP (transformers.js), test providers, model cache
  storage/          SQLite index store, writer lock
  indexing/         incremental index orchestration
  search/           vector scan, ranking and fusion, search services
  contact-sheet/    grid rendering, waveforms
scripts/eval/       retrieval benchmark on labeled CC0 game assets (Kenney)
test/unit/          fast tests with deterministic model-free providers and small fixtures
test/model/         real-model integration tests: SigLIP, CLAP, 3D (need ASSETD_MODEL_DIR)
test/fixtures/      small CC0 and synthetic assets (see its README)
skills/assetd/      optional agent skill
```
