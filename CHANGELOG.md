# Changelog

JSON output keeps `schemaVersion: 1` throughout: every change below only adds
fields or enum values (see docs/cli-contract.md for the compatibility rules).

## 0.2.0

### Added

- **Sounds** (WAV, OGG, MP3, FLAC, Opus, M4A, AIFF), decoded with WebAssembly
  (no FFmpeg) and embedded with CLAP (`clap-general`). Metadata: duration,
  channels, sample rate, average bitrate, peak/RMS level.
- **3D models** (GLB, glTF with Draco/meshopt, OBJ+MTL, FBX binary/ASCII 6.1+).
  Metadata: geometry counts, materials, textures, bounding box, dimensions,
  animations, skeleton, units, up axis, generator, missing resources.
- 3D models are **searchable**: rendered by a built-in software rasterizer and
  embedded with SigLIP in the same space as images. `similar` cross-matches
  images and 3D models (`--type image` / `--type model3d`).
- Derived **previews** for 3D models in `.asset-index/previews/`, listed by
  `inspect` and used by `contact-sheet`; sounds appear as waveforms there.
- `search` without `--type` merges all indexed kinds (`ranking:
  "zscore-fusion/v2"`); query words such as "sound", "icon" or "3D model"
  favour that kind.
- Configuration: `models.audio`, `models.audioDtype`, `model3d.views` (1, 2, 4),
  preset `siglip-large`; environment variable `ASSETD_AUDIO_MODEL`.
- JSON fields: `models` (every enabled channel's model) on `index`, `search`,
  `status` and `models`; `channel` in model info; `signals.audio`, `signals.z`,
  `signals.intent`; `sourceVersion`/`sourceUnitScale` for FBX metadata.
- Retrieval benchmark (`npm run eval`) on labeled CC0 game assets, with results
  in docs/evaluation.md.

### Changed

- The audio and 3D processors are **enabled by default**. Their models load only
  when a project actually contains such files; disable them with
  `"processors": { "audio": false, "model3d": false }`.
- `search --type` and `similar --type` accept `audio` and `model3d`.
- In results for sounds, `signals.audio` carries the cosine and `signals.visual`
  is absent; image and 3D results keep `signals.visual`.
- `ranking` is `"audio+lexical/v1"` for audio-only searches (image searches
  keep `"visual+lexical/v1"`).

### Fixed

- A recorded root that was deleted entirely is now forgotten by `index`
  (it used to be treated as unreadable and kept forever).
- `inspect` no longer reports assets of a kind without embeddings as `stale`.
- On case-insensitive filesystems, a path typed with the wrong letter case is
  reported with its on-disk spelling.

## 0.1.0

First release: image indexing (SigLIP), `index`, `ensure-index`, `search`,
`similar`, `inspect`, `status`, `contact-sheet`, `models`, stable `--json`
output and exit codes, Windows and Linux CI.
