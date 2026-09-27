# CLI contract

The CLI is the API. Humans and agents run the same commands; `--json` switches
the output to a stable machine-readable document.

## Rules in `--json` mode

- **stdout** carries exactly one JSON document (pretty-printed, UTF-8), and nothing else.
- **stderr** carries diagnostics: warnings, model download notices, progress
  (progress only when stderr is a TTY). `--quiet` silences informational lines.
- No ANSI colors, no prompts, in any mode.
- Every document has `"schemaVersion": 1` and `"command": "<name>"`.
- Paths are **logical**: project-relative, `/`-separated on every OS
  (`assets/props/chest.png`). A path outside the project (e.g. an external
  reference image for `similar`) is printed as an absolute native path.
- On error, stdout carries an error document and the process exits non-zero:

```json
{
  "schemaVersion": 1,
  "command": "inspect",
  "error": { "code": "PATH_NOT_FOUND", "exitCode": 4, "message": "File not found: nope.png", "details": { "path": "nope.png" } }
}
```

Compatibility: releases with the same `schemaVersion` only **add** fields
(and, for enums such as `kind` or `type`, add values).
Renaming or removing a field, or changing its meaning, bumps `schemaVersion`.
The authoritative schemas are the Zod definitions in `src/contracts/json.ts`.

## Exit codes

| Code | Name | Meaning |
|---:|---|---|
| 0 | `OK` | Success (including `status` when no index exists: see `indexed: false`) |
| 1 | `INTERNAL_ERROR` | Unexpected failure (set `ASSETD_DEBUG=1` for a stack trace) |
| 2 | `USAGE_ERROR` | Bad arguments, invalid `assetd.json`, unsupported `--type` |
| 3 | `INDEX_NOT_FOUND` | No `.asset-index/` in this directory or any parent |
| 4 | `PATH_NOT_FOUND` | The given file/directory does not exist or is outside the project |
| 5 | `NOT_INDEXED` | The file exists but cannot be used (unsupported type, undecodable) |
| 6 | `MODEL_UNAVAILABLE` | Model weights missing (offline) or failed to load |
| 7 | `PARTIAL_FAILURE` | `index --strict` finished but some files failed |
| 8 | `INDEX_BUSY` | Another `assetd index` holds the index lock |
| 9 | `INDEX_INCOMPATIBLE` | The index was written by a newer assetd |
| 130 | `INTERRUPTED` | `index` was interrupted (Ctrl+C); finished work is kept |

## Commands

### `assetd index [directory...] [--retry-failed] [--strict]`

Scans the directories (default: the roots recorded by earlier runs, else
`roots` from `assetd.json`, else the project root) and brings the index up to
date. `assetd ensure-index` is the same operation without arguments.

```json
{
  "schemaVersion": 1, "command": "index",
  "root": ".", "roots": ["assets"],
  "model": { "space": "siglip:Xenova/siglip-base-patch16-224:q8:r1", "provider": "siglip", "model": "siglip-base (Xenova/siglip-base-patch16-224)", "dtype": "q8", "dimensions": 768 },
  "discovered": 1284, "supported": 1280, "indexed": 43, "unchanged": 1227, "removed": 4, "failed": 10,
  "reusedEmbeddings": 2, "interrupted": false, "elapsedMs": 5120,
  "failures": [{ "path": "assets/ui/broken.png", "error": "Processing failed: ..." }],
  "warnings": []
}
```

`discovered` counts every file seen under the roots after ignore rules;
`supported` those an enabled processor handles. `unchanged` includes files that
failed before and did not change (use `--retry-failed` to try them again).

### `assetd search "<query>" [--type image|audio] [--limit 10] [--in <dir>]`

Without `--type`, every indexed kind is searched. If only one kind has indexed
assets (e.g. an image-only project), the output is exactly the single-kind
search below (`type` is that kind). If several kinds have assets, `type` is
`"all"` and `ranking` is `"zscore-fusion/v2"` (see *Scores* below).

```json
{
  "schemaVersion": 1, "command": "search",
  "query": "wooden treasure chest", "type": "image", "limit": 10, "within": null,
  "ranking": "visual+lexical/v1",
  "model": { "channel": "visual", "...": "..." },
  "models": [{ "channel": "visual", "...": "..." }],
  "candidates": 1384,
  "results": [
    {
      "rank": 1, "path": "assets/props/chest.png", "kind": "image", "score": 0.1432,
      "signals": { "visual": 0.1182, "lexical": 0.5 },
      "metadata": { "width": 512, "height": 512, "format": "png", "hasTransparency": true, "...": "..." }
    }
  ],
  "timings": { "totalMs": 540, "embedMs": 340, "searchMs": 6, "queryCached": false }
}
```

**Scores** are only comparable **within one result list**.

- Single kind (`ranking` `visual+lexical/v1` or `audio+lexical/v1`):
  `score = semantic + 0.05 × lexical`. `signals.visual` (images, SigLIP) or
  `signals.audio` (sounds, CLAP) is the cosine similarity in that model's joint
  text–media space — good SigLIP matches are typically 0.08–0.20, not near 1.0 —
  and `signals.lexical` is the fraction of query words found in the path.
- Several kinds (`zscore-fusion/v2`): cosines from different models are never
  compared. Each kind's semantic scores are standardized over all of that
  kind's candidates for the query (`signals.z`), shrunk by `n / (n + 10)` so
  that a kind with a handful of assets cannot dominate; then
  `score = z + 1 × lexical + 4 × intent`, the same weights for every kind.
  `signals.intent` is 1 for the kind the query explicitly names ("the sound
  of coins", "a sword icon", "wind ambience"); 0 otherwise.
  `signals.visual`/`signals.audio` still carry the raw cosine.

Audio results carry `metadata` such as `durationSeconds`, `channels`,
`sampleRate`, `format`, `bitrateKbps` (average), `peakDb`, `rmsDb`.

### `assetd similar <path> [--limit 10] [--in <dir>]`

`<path>` may be an indexed asset, an unindexed file in the project, or any image
or sound elsewhere on disk (it is embedded on the fly). Results are of the
reference's kind (image → images via SigLIP, sound → sounds via CLAP); passing
a different `--type` is a usage error. The reference itself is excluded;
byte-identical copies are marked `"duplicate": true`.

```json
{ "schemaVersion": 1, "command": "similar", "reference": { "path": "assets/items/sword.png", "indexed": true },
  "type": "image", "limit": 10, "within": null, "model": { "...": "..." }, "candidates": 1384,
  "results": [{ "rank": 1, "path": "assets/items/sword_alt.png", "kind": "image", "score": 0.91, "signals": { "visual": 0.91, "lexical": 0 }, "metadata": {}, "duplicate": false }],
  "timings": { "totalMs": 120 } }
```

### `assetd inspect <path>`

```json
{
  "schemaVersion": 1, "command": "inspect",
  "path": "assets/props/chest.png", "exists": true, "state": "indexed",
  "kind": "image", "extension": "png", "size": 20480, "modifiedAt": "2026-09-27T12:00:00.000Z",
  "contentHash": "sha256 hex",
  "metadata": { "width": 512, "height": 512, "aspectRatio": 1, "aspect": "1:1", "format": "png",
                "hasAlphaChannel": true, "hasTransparency": true, "dominantColor": "#6b4a2b", "channels": 4, "colorSpace": "srgb" },
  "description": null, "tags": [],
  "processor": { "id": "image", "version": "1" },
  "embeddings": [{ "channel": "visual", "space": "siglip:Xenova/siglip-base-patch16-224:q8:r1", "dimensions": 768, "current": true }],
  "previews": [], "indexedAt": "2026-09-27T12:00:05.000Z", "error": null, "otherMatches": []
}
```

`state`: `indexed` · `stale` (file or processor/model changed since indexing) ·
`failed` · `not-indexed` (exists, supported, not indexed yet: metadata is
extracted live) · `unsupported` · `missing` (in the index, gone from disk).
Vectors are never printed. `otherMatches` lists indexed paths that differ only
in letter case or Unicode normalization.

Path arguments are accepted relative to the cwd, absolute, or project-relative,
with either separator; letter case is matched tolerantly when unambiguous.

### `assetd status [--no-stale-check]`

```json
{
  "schemaVersion": 1, "command": "status",
  "indexed": true, "root": ".", "indexDir": ".asset-index", "roots": ["assets"],
  "assets": 1384, "types": { "image": 1384 }, "failed": 3, "failures": [{ "path": "...", "error": "..." }],
  "processors": [{ "id": "image", "version": "1", "enabled": true }], "unavailableProcessors": [],
  "model": { "space": "...", "provider": "siglip", "model": "...", "dtype": "q8", "dimensions": 768, "cached": true },
  "indexVersion": 1, "stale": false,
  "staleness": { "added": 0, "modified": 0, "removed": 0, "missingEmbeddings": 0, "outdatedProcessor": 0 },
  "lastIndexedAt": "2026-09-27T12:00:05.000Z"
}
```

The staleness check only stats files (no hashing, no model). With
`--no-stale-check`, `stale` and `staleness` are `null`. Without an index:
`"indexed": false`, exit code 0.

### `assetd contact-sheet <path...> | --search "<query>" [--type image|audio] [--limit 20] [--out file.png] [--columns N] [--thumb-size 192]`

Renders the candidates into one PNG grid; sounds are drawn as waveforms with
their duration in the caption (so an agent that cannot listen still sees
short hit vs. long loop). Every tile carries a numeric badge
(drawn from a built-in bitmap font, identical on every OS) plus a filename
caption. Without `--out` the file goes to `.asset-index/contact-sheets/`,
named after its inputs so identical requests reuse it.

```json
{ "schemaVersion": 1, "command": "contact-sheet", "output": ".asset-index/contact-sheets/e497baff09e8d106.png",
  "width": 608, "height": 674, "columns": 3, "rows": 3,
  "items": [{ "label": "1", "path": "assets/ui/img_0079.png", "error": null }] }
```

### `assetd models <status|pull>`

`pull` downloads the weights of every enabled channel now (for later offline
use) and runs one tiny embedding per model to confirm they work. `model` is the
visual model (compatibility); `models` lists all.

```json
{ "schemaVersion": 1, "command": "models", "action": "status", "cacheDir": "/home/u/.cache/assetd/models", "offline": false,
  "model": { "space": "...", "provider": "siglip", "model": "...", "dtype": "q8", "dimensions": 768, "cached": true } }
```

## Environment variables

| Variable | Effect |
|---|---|
| `ASSETD_MODEL_DIR` | Model weight cache directory (default: see docs/architecture.md) |
| `ASSETD_OFFLINE=1` (or `HF_HUB_OFFLINE=1`) | Never touch the network; missing weights → exit 6 |
| `ASSETD_VISUAL_MODEL` | Override `models.visual` (e.g. `clip-vit-b32`) |
| `ASSETD_AUDIO_MODEL` | Override `models.audio` (e.g. `clap-htsat-unfused`) |
| `ASSETD_MODEL_DTYPE` | Override `models.dtype` (`q8`, `fp16`, `fp32`) |
| `ASSETD_THREADS` | Cap ONNX Runtime intra-op threads (default: runtime decides) |
| `ASSETD_DEBUG=1` | Print stack traces for internal errors |
