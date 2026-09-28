# Retrieval evaluation

How well does `assetd search` find the right asset from a description, and
which model should be the default? Measured with `scripts/eval/eval.ts` on
real game assets, reproducible with:

```text
node scripts/eval/eval.ts fetch
node scripts/eval/eval.ts run --kind image --models siglip-base,clip-vit-b32
node scripts/eval/eval.ts run --kind audio --models clap-general,clap-htsat-unfused
```

## Method

- **Corpus**: CC0 packs by Kenney (pinned URLs and SHA-256 in
  `scripts/eval/datasets.json`). Images: animal pack, board-game icons, emotes,
  game icons, platformer art deluxe — 1,361 unique files. Audio: impact,
  interface, RPG and sci-fi sounds — 353 unique OGG files.
- **Blind filenames**: every file is copied under its content hash, so path
  words contribute nothing; only the embedding model is measured.
- **Labels**: each query (`scripts/eval/{image,audio}-queries.json`) has a regex
  over the original filename; any matching file is relevant. 59 image
  queries, 35 audio queries.
- **Metrics**: Hit@k (a relevant file among the first k), MRR@10.
- **Hardware**: Linux, 28-thread desktop CPU, no GPU, Node 26.

Caveats. With 59 (35) queries one query is ~1.7 (~2.9) percentage points, so
differences of a few points are noise. Filename labels are imperfect in both
directions: a tile named `houseBeigeMidLeft` counts as "a house"; a `home` icon
does not, and generic `footstep04` does not count as "footsteps on a wooden
floor". Absolute numbers therefore underestimate what a person would call a
good result; the comparison between models is the useful part.

## Images

| Model (ONNX weights) | Hit@1 | Hit@5 | Hit@10 | MRR@10 | Index (img/s) | Query embed (ms) |
|---|---:|---:|---:|---:|---:|---:|
| **siglip-base** — SigLIP B/16 224, int8 (default) | 69% | 85% | 86% | 0.750 | 11.8 | 22 |
| siglip-base, fp32 | 73% | 81% | 85% | 0.763 | 8.9 | 36 |
| SigLIP B/16 256, int8 | 69% | 85% | 86% | 0.762 | 8.7 | 22 |
| siglip-large — SigLIP L/16 256, int8 | 73% | 86% | 86% | 0.777 | 3.1 | 59 |
| clip-vit-b32 — CLIP B/32, int8 | 44% | 66% | 69% | 0.528 | 28.9 | 4 |
| CLIP B/16, int8 | 46% | 68% | 75% | 0.550 | 12.8 | 5 |
| SigLIP 2 B/16 224 (onnx-community), int8 | 17% | 47% | 53% | 0.285 | 11.4 | 19 |

- SigLIP beats CLIP by ~20 points of Hit@5 at similar size. The default stays
  **SigLIP base int8**.
- fp32 weights and the 256 px variant are within noise of int8/224 and slower.
- SigLIP large is the best by a small margin (+2.7 points MRR) at a quarter of
  the indexing speed and ~640 MB of weights; available as `"visual": "siglip-large"`.
- SigLIP 2's result is far below its published quality, which points to a
  preprocessing/tokenizer mismatch between that ONNX export and transformers.js
  rather than to the model. It is not offered as a preset.

Typical remaining misses: board-game symbols in isolation ("the spades card
suit", "a chess knight"), and objects that exist only as tile fragments
("a castle", "a ladder").

## Audio

| Model (ONNX weights) | Hit@1 | Hit@5 | Hit@10 | MRR@10 | Index (sounds/s) | Query embed (ms) |
|---|---:|---:|---:|---:|---:|---:|
| **clap-general** — LAION larger_clap_general, int8 (default) | 31% | 57% | 71% | 0.424 | 5.7 | 9 |
| clap-htsat-unfused, int8 | 29% | 57% | 63% | 0.409 | 4.5* | 4 |
| clap-general, fp32 | 26% | 57% | 66% | 0.380 | 0.9* | 9 |
| clap-htsat-unfused, fp32 | 31% | 54% | 63% | 0.409 | 2.1* | 8 |

\* measured before audio batching (see below); clap-general int8 went from
2.0 to 5.7 sounds/s with it, the others would improve similarly.

- Audio retrieval is clearly harder than images: Hit@5 57% vs 85%. Many
  queries need fine distinctions (footsteps on snow vs. grass vs. carpet), and
  the misses list shows many near misses of that kind (e.g. "a heavy metal
  impact" → `metalPot2`, `impactPlate_medium_002`).
- **clap-general** stays the default: best MRR and Hit@10. fp32 does not help.
- Throughput is dominated by the audio tower (~200 ms per call, because CLAP
  always processes a 10 s window and repeats short clips to fill it). Batching
  four windows per call gave ~2.9× end-to-end; vectors agree with unbatched
  ones to cosine ≥ 0.9994 (int8 kernel noise, the same as for batched images),
  and retrieval quality stayed within one query.

## 3D models

Corpus: four Kenney kits (food, furniture, nature, blasters) — 709 GLB models,
blind names, 107 queries ("a canoe", "an office chair", "a toy blaster gun",
"a pine tree"...). Models are rendered by assetd's software rasterizer and the
renders embedded with SigLIP base int8; with several views the vectors are
averaged.

| Views per model | Hit@1 | Hit@5 | Hit@10 | MRR@10 | Index (models/s) |
|---|---:|---:|---:|---:|---:|
| 1 (perspective) | 77% | 90% | 96% | 0.827 | 12.9 |
| **2 (opposite perspectives, default)** | 76% | 92% | 97% | 0.832 | 5.5 |
| 4 (perspectives around) | 75% | 95% | 98% | 0.824 | 2.8 |

On the food kit alone (200 models, 60 queries) one view already reached 97%
Hit@5 and the seven "front/back/left/right/top/2 perspectives" views of the
original plan were the worst and slowest (95%, 1.6 models/s). More views help
recall at the top-5/10 cut-offs, not the first hit, and cost a SigLIP call each.
The default is two opposite perspectives (robust to models authored facing
backwards) at 2.3× the cost of one; `"model3d": { "views": 1 | 2 | 4 }` in
`assetd.json` trades speed for recall.

### FBX

The same 709 models exported as FBX by the same kits (binary FBX 7.7 for food
and blasters, ASCII FBX 7.3 for furniture and nature) all load, and all 709
have exactly the triangle count of their GLB counterpart. With the default two
views:

| Format | Hit@1 | Hit@5 | Hit@10 | MRR@10 | Index (models/s) |
|---|---:|---:|---:|---:|---:|
| GLB | 76% | 92% | 97% | 0.832 | 5.5 |
| FBX | 68% | 87% | 92% | 0.770 | 5.6 |

Renders of FBX and GLB pairs have the same geometry. Two differences come from
the files, not from reading them: some FBX models face the other way (a 180°
turn; two opposite views make their averaged vector almost orientation-free),
and FBX material colors are more saturated. Kenney's official preview images
match the FBX colors; the GLB exports store the same sRGB numbers in glTF's
linear color field and render washed out. The lower FBX score most likely comes
from those colour changes among the distractors (e.g. yellowish cliffs now
compete with "a wedge of cheese"); this was not verified query by query.

Remaining misses are mostly labelling artifacts ("a coconut" → palm trees,
"a mushroom in the forest" → food-kit mushrooms) and near neighbours ("a raw
steak" → meat patty, ham).

## Mixed image + audio search

Checked by hand on the 1,729-file combined corpus (real filenames). What the
evaluation changed:

1. A fixed filename bonus in cosine units favoured images, because 0.05 is
   2.4–2.8 standard deviations of SigLIP scores but only 0.6–0.7 for CLAP
   (measured on four queries over each corpus). The bonus
   now lives in z units, identical for every kind (`zscore-fusion/v2`):
   "footsteps on grass" went from six grass tiles to `footstep_grass_000.ogg` first.
2. Queries that name a kind ("the sound of coins", "a laser gun shot sound",
   "a sword icon") get a strong preference for that kind: before the change,
   coin images still outranked `handleCoins.ogg`.

Neutral queries still mix kinds sensibly: "a door" → `doorOpen_1.ogg`,
`iglooDoor.png`, `exit.png`, `doorOpen_2.ogg`; "a big explosion" → explosion
sounds with `bomb.png` in between. Agents that know the kind should pass `--type`.
