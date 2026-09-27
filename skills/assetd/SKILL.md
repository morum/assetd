---
name: assetd
description: Find existing project assets (images, sprites, textures, icons) by meaning instead of browsing directories. Use before recursively searching asset folders, and before creating or generating a new asset that might already exist.
---

# Finding project assets with assetd

`assetd` is a local semantic index over the project's asset files. It runs
offline, needs no server, and prints stable JSON with `--json` (stdout holds
only the JSON document; diagnostics go to stderr).

## Workflow

1. Check the index: `assetd status --json`
   - `"indexed": false` → run `assetd index <assets-dir> --json` (first run downloads a ~200 MB model once).
   - `"stale": true` → run `assetd ensure-index --json` (only changed files are processed).
2. Search by description: `assetd search "<what it looks like>" --limit 10 --json`
   - Describe the visual content ("dark wooden door, pixel art"), not the filename.
   - Narrow with `--in <dir>` when you know the area.
   - `score` is only meaningful relative to the other results of the same query.
3. From a reference image (in the project or anywhere on disk): `assetd similar "<path>" --json`
   - `"duplicate": true` marks byte-identical copies.
4. Check a candidate: `assetd inspect "<path>" --json` (dimensions, alpha, format, index state).
5. When several candidates are plausible and you can view images:
   `assetd contact-sheet "<p1>" "<p2>" ... --json` (or `--search "<query>" --limit 20`),
   then open the PNG at `output`; tiles are numbered by `items[].label`.

Returned paths are project-relative with `/` separators on every OS and can be
used directly.

## Guidance

- Prefer a suitable existing asset over creating a duplicate; say which one you chose and why.
- Do not recurse through asset directories to "look for" images when assetd is available.
- Exit codes: 0 ok, 2 usage, 3 no index, 4 path not found, 5 unsupported file, 6 model unavailable, 8 index busy. On failure stdout still holds a JSON `error` object.
- Currently only images are indexed (PNG, JPEG, WebP, GIF, TIFF, AVIF, SVG).
