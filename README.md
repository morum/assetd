# assetd

Local-first semantic search over the assets already in your project folder,
built for AI coding agents (Claude Code, Codex, Cursor, …) and just as usable by
humans and scripts.

```text
assetd index ./assets
assetd search "dark medieval wooden door"
assetd similar ./assets/props/chest.png
assetd inspect ./assets/props/chest.png
assetd status
```

- **Filesystem-first, non-destructive**: point it at a directory; nothing is
  moved, renamed or imported. Derived data lives in `.asset-index/`
  (self-gitignored).
- **Local and offline**: SigLIP runs on CPU through ONNX Runtime inside Node.js.
  No cloud API, account, telemetry, Python, CUDA, Docker or server. Weights
  (~200 MB) download once; afterwards it works offline.
- **Daemon-free**: every command starts, does its work, exits. A cold text search
  takes about half a second; a repeated one about 0.1 s.
- **Incremental**: only new or changed files are processed; deleted files leave
  the index; identical files share one embedding.
- **Agent-friendly**: `--json` on every command, stable schemas, documented exit
  codes, project-relative `/` paths on every OS.
- **Windows and Linux** are both first-class (CI runs on both).

This release indexes **images** (PNG, JPEG, WebP, GIF, TIFF, AVIF, SVG) with
SigLIP and **sounds** (WAV, OGG, MP3, FLAC, Opus, M4A, AIFF) with CLAP, decoded
by bundled WASM decoders (no FFmpeg). 3D models, text and video are planned as
separate processors.

## Install

Requires Node.js ≥ 22.13 on Windows or Linux (x64/arm64). macOS should work but is not tested.

```text
git clone <this repo> assetd
cd assetd
npm ci
npm run build
npm link            # puts `assetd` on your PATH (or run: node dist/cli/main.js)
```

Optionally download the model up front (e.g. before going offline):

```text
assetd models pull
```

## Use

From the project root:

```text
assetd index ./assets
```

```text
Discovered:  1,284 files (1,280 supported)
Indexed:        43
Unchanged:   1,227
Removed:         4
Failed:         10
```

Run `assetd index` again (no arguments) or `assetd ensure-index` any time; it
re-scans the recorded roots and does the minimum work.

```text
assetd search "short metallic sword" --limit 5
assetd search "heavy metal impact" --type audio
assetd similar ./assets/sfx/door_creak.ogg
assetd search "health potion icon" --in assets/ui --json
assetd similar C:\Users\me\Downloads\reference.png --json
assetd contact-sheet --search "treasure chest" --limit 12
assetd status --json
```

Search output (human):

```text
0.143  assets/items/sword_dark.png  64x64 png alpha
0.121  assets/items/sword.png  64x64 png alpha
```

Scores are relative within one query (see [docs/cli-contract.md](docs/cli-contract.md)).

### Contact sheets

Semantic search is candidate generation. `assetd contact-sheet` renders the
candidates into one numbered grid so a multimodal agent (or you) can pick
visually in a single look.

## Configuration (optional)

Zero-config works. To customize, add `assetd.json` at the project root:

```json
{
  "roots": ["assets", "content"],
  "ignore": ["**/*_backup.*"],
  "respectGitignore": false,
  "processors": { "image": true, "audio": true },
  "models": { "visual": "siglip-base", "dtype": "q8", "audio": "clap-general" }
}
```

`.assetignore` at the project root uses gitignore syntax:

```text
build/
dist/
cache/
*.tmp
```

Built-in ignores: `.git/ .hg/ .svn/ node_modules/ .godot/ .import/` (disable
with `"defaultIgnores": false`). Matching is case-insensitive on every OS.

Visual models: `siglip-base` (default), `clip-vit-b32`, or `"siglip:<org>/<repo>"`
for another transformers.js-compatible ONNX export. Audio models:
`clap-general` (default), `clap-htsat-unfused`, or `"clap:<org>/<repo>"`. The
audio model is only downloaded once the project actually contains sounds.
Model choices are backed by `npm run eval` (see docs/architecture.md). `dtype` `fp32` is more accurate
and larger. Switching models re-embeds everything once; both spaces are kept
apart.

## For AI agents

The CLI is the API; no SDK or protocol server is needed. An optional,
repository-agnostic skill lives in [skills/assetd/SKILL.md](skills/assetd/SKILL.md).
To use it with Claude Code, copy the folder to `.claude/skills/assetd/` (project)
or `~/.claude/skills/assetd/` (user); for other agents, paste its body into
`AGENTS.md` or the agent's instruction file.

Typical agent loop:

```text
assetd status --json                      → indexed? stale?
assetd search "wooden treasure chest inventory icon" --limit 10 --json
assetd inspect assets/ui/chest.png --json → size, alpha, state
assetd contact-sheet <candidates...> --json → open the PNG, choose
```

## Development

```text
npm ci
npm test              # build + fast unit/CLI tests (no model download)
npm run typecheck
ASSETD_MODEL_DIR=<dir> npm run test:model   # real SigLIP + CLAP end-to-end tests
node scripts/eval/eval.ts fetch               # download the labeled CC0 eval corpus
node scripts/eval/eval.ts run --kind image --models siglip-base,clip-vit-b32
```

The same commands work in PowerShell, cmd and bash. Fast tests use a
deterministic model-free providers (`ASSETD_VISUAL_MODEL=test-hash`,
`ASSETD_AUDIO_MODEL=test-audio`) and fixtures in temporary directories.

## Documentation

- [docs/cli-contract.md](docs/cli-contract.md): commands, JSON schemas, exit codes, environment variables
- [docs/architecture.md](docs/architecture.md): design decisions, dependencies per platform, storage, measurements
