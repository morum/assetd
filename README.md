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
- **Local and offline**: SigLIP (images, 3D) and CLAP (sounds) run on CPU through
  ONNX Runtime inside Node.js. No cloud API, account, telemetry, Python, CUDA,
  Docker or server. Weights download once (~200 MB each; CLAP only if the project
  has sounds); afterwards it works offline.
- **Daemon-free**: every command starts, does its work, exits. A cold text search
  takes about half a second; a repeated one about 0.1 s.
- **Incremental**: only new or changed files are processed; deleted files leave
  the index; identical files share one embedding.
- **Agent-friendly**: `--json` on every command, stable schemas, documented exit
  codes, project-relative `/` paths on every OS.
- **Windows and Linux** are both first-class (CI runs on both).

This release indexes **images** (PNG, JPEG, WebP, GIF, TIFF, AVIF, SVG) with
SigLIP and **sounds** (WAV, OGG, MP3, FLAC, Opus, M4A, AIFF) with CLAP, decoded
by bundled WASM decoders (no FFmpeg). 3D models (GLB, glTF with Draco/meshopt,
OBJ+MTL, FBX) are indexed with their metadata (geometry, materials, textures,
bounds, animations, skeleton) and made searchable by rendering them in software
and embedding the renders with SigLIP — no GPU, Blender or native binary.
Text and video are planned as separate processors.

## Install

Requires Node.js ≥ 22.13 on Windows or Linux (x64/arm64). macOS should work but is not tested.

```text
git clone <this repo> assetd
cd assetd
npm ci
npm run build
npm link            # puts `assetd` on your PATH (or run: node dist/cli/main.js)
```

Optionally download the models up front (e.g. before going offline):

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
assetd search "low-poly pine tree" --type model3d
assetd similar ./assets/models/sword.glb --type image   # icons that match a model
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

Without `--type`, all indexed kinds are searched and merged fairly (each kind is
standardized against itself; words like "sound", "icon" or "3D model" in the
query favour that kind). Images and 3D models share one embedding space, so
`similar` can go from a model to matching icons and back.

### Contact sheets

Semantic search is candidate generation. `assetd contact-sheet` renders the
candidates into one numbered grid — images as thumbnails, 3D models as renders,
sounds as waveforms with their duration — so a multimodal agent (or you) can
pick visually in a single look.

## Configuration (optional)

Zero-config works. To customize, add `assetd.json` at the project root:

```json
{
  "roots": ["assets", "content"],
  "ignore": ["**/*_backup.*"],
  "processors": { "image": true, "audio": true, "model3d": true },
  "models": { "visual": "siglip-base", "audio": "clap-general" },
  "model3d": { "views": 2 }
}
```

| Key | Default | Meaning |
|---|---|---|
| `roots` | recorded roots, else the project root | Directories scanned by `assetd index` without arguments |
| `ignore` | `[]` | Extra gitignore-style patterns (added to `.assetignore`) |
| `respectGitignore` | `false` | Also apply the root `.gitignore` |
| `defaultIgnores` | `true` | Built-in ignores (below) |
| `maxFileSizeMb` | `256` | Larger files are recorded as failed instead of decoded |
| `processors.image` / `.audio` / `.model3d` | `true` | Enable each kind (`video`, `text`: not available yet) |
| `models.visual` | `"siglip-base"` | Image and 3D model: `siglip-base`, `siglip-large`, `clip-vit-b32`, or `"siglip:<org>/<repo>"` |
| `models.dtype` | `"q8"` | Visual weights: `q8`, `fp16`, `fp32` |
| `models.audio` | `"clap-general"` | Sound model: `clap-general`, `clap-htsat-unfused`, or `"clap:<org>/<repo>"` |
| `models.audioDtype` | `"q8"` | Audio weights |
| `model3d.views` | `2` | Renders embedded per 3D model: `1` (fastest), `2`, `4` (best recall) |

`.assetignore` at the project root uses gitignore syntax:

```text
build/
dist/
cache/
*.tmp
```

Built-in ignores: `.git/ .hg/ .svn/ node_modules/ .godot/ .import/` (disable
with `"defaultIgnores": false`). Matching is case-insensitive on every OS.

The defaults were chosen by measurement on labeled CC0 game assets
([docs/evaluation.md](docs/evaluation.md)): larger or fp32 models gain a few
points at several times the cost. Switching a model re-embeds the affected
assets once; different models' vectors are never mixed.

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
assetd inspect assets/ui/chest.png --json → size, alpha, duration, triangles, state
assetd contact-sheet <candidates...> --json → open the PNG, choose
```

## Development

```text
npm ci
npm test              # build + fast unit/CLI tests (no model download)
npm run typecheck
ASSETD_MODEL_DIR=<dir> npm run test:model   # real SigLIP, CLAP and 3D end-to-end tests
npm run eval -- fetch                        # download the labeled CC0 eval corpora (Node ≥ 22.18)
npm run eval -- run --kind image --models siglip-base,clip-vit-b32
npm run eval -- run --kind audio --models clap-general,clap-htsat-unfused
npm run eval -- run --kind model3d --models "siglip-base[perspective1,perspective2]"
```

The same commands work in PowerShell, cmd and bash. Fast tests use
deterministic model-free providers (`ASSETD_VISUAL_MODEL=test-hash`,
`ASSETD_AUDIO_MODEL=test-audio`) and write only to temporary directories.

## Known limitations

- Text files and video are not indexed yet.
- FBX older than 6.1 is refused; `.blend` and other native editor files are not read.
- Editing only a 3D model's external textures or `.bin` does not trigger re-indexing
  (re-save the model file).
- Sound retrieval is clearly weaker than image retrieval (Hit@5 57% vs 85% on the
  evaluation set); many misses are near neighbours (a metal pot for "a heavy metal
  impact").
- macOS is expected to work but is not tested; Windows is tested in CI but not
  profiled on a workstation.

## Documentation

- [docs/cli-contract.md](docs/cli-contract.md): commands, JSON schemas, exit codes, environment variables
- [docs/architecture.md](docs/architecture.md): design decisions, dependencies per platform, storage, performance
- [docs/evaluation.md](docs/evaluation.md): retrieval benchmarks behind the default models and settings
- [CHANGELOG.md](CHANGELOG.md): what changed between versions, including behaviour changes
