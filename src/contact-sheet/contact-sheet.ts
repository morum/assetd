import fs from "node:fs/promises";
import sharp, { type OverlayOptions } from "sharp";
import { errorMessage } from "../core/errors.ts";
import { renderWaveform } from "./waveform.ts";

export interface ContactSheetItem {
  label: string;
  /** Native path of the image to show (the asset itself, or a derived preview later). */
  nativePath: string;
  caption: string;
  /** Audio items are shown as a waveform of these (mono) samples. */
  waveform?: Float32Array;
  /** Encoded image to show instead of reading `nativePath` (e.g. a live 3D render). */
  image?: Buffer;
}

export interface ContactSheetOptions {
  thumbSize?: number;
  columns?: number;
}

export interface ContactSheetResult {
  png: Buffer;
  width: number;
  height: number;
  columns: number;
  rows: number;
  errors: Map<string, string>;
}

// 3x5 bitmap digits: labels render identically everywhere, no font dependency.
const DIGITS: Record<string, string> = {
  "0": "111101101101111",
  "1": "010110010010111",
  "2": "111001111100111",
  "3": "111001111001111",
  "4": "101101111001001",
  "5": "111100111001111",
  "6": "111100111101111",
  "7": "111001010010010",
  "8": "111101111101111",
  "9": "111101111001111",
};

const CAPTION_HEIGHT = 22;
const GAP = 8;
const BADGE_SCALE = 4;

/** Renders a numeric badge (white digits on a dark rounded-ish box) as raw RGBA. */
function renderBadge(label: string): { data: Buffer; width: number; height: number } {
  const digits = [...label].filter((c) => DIGITS[c]);
  const pad = 4;
  const glyphW = 3 * BADGE_SCALE;
  const glyphH = 5 * BADGE_SCALE;
  const width = pad * 2 + digits.length * glyphW + Math.max(0, digits.length - 1) * BADGE_SCALE;
  const height = pad * 2 + glyphH;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([20, 20, 28, 230], i * 4);
  digits.forEach((d, n) => {
    const bits = DIGITS[d]!;
    const x0 = pad + n * (glyphW + BADGE_SCALE);
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (bits[gy * 3 + gx] !== "1") continue;
        for (let sy = 0; sy < BADGE_SCALE; sy++) {
          for (let sx = 0; sx < BADGE_SCALE; sx++) {
            const px = x0 + gx * BADGE_SCALE + sx;
            const py = pad + gy * BADGE_SCALE + sy;
            data.set([255, 255, 255, 255], (py * width + px) * 4);
          }
        }
      }
    }
  });
  return { data, width, height };
}

/** Light checkerboard so transparent sprites stay visible. */
function checkerboard(size: number): Buffer {
  const data = Buffer.alloc(size * size * 3);
  const cell = 12;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0 ? 236 : 216;
      data.fill(v, (y * size + x) * 3, (y * size + x) * 3 + 3);
    }
  }
  return data;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  return s.slice(0, Math.ceil(keep / 2)) + "…" + s.slice(s.length - Math.floor(keep / 2));
}

/** Caption text via SVG. Best-effort: depends on system fonts, the numeric badge does not. */
async function renderCaption(text: string, width: number): Promise<Buffer | null> {
  const maxChars = Math.max(6, Math.floor(width / 7));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${CAPTION_HEIGHT}">` +
    `<text x="${width / 2}" y="15" font-family="DejaVu Sans, Segoe UI, Arial, sans-serif" font-size="12" text-anchor="middle" fill="#202020">` +
    `${escapeXml(truncateMiddle(text, maxChars))}</text></svg>`;
  try {
    return await sharp(Buffer.from(svg)).png().toBuffer();
  } catch {
    return null;
  }
}

async function renderTile(item: ContactSheetItem, thumb: number, board: Buffer): Promise<Buffer> {
  if (item.waveform) {
    return sharp(renderWaveform(item.waveform, thumb, thumb), { raw: { width: thumb, height: thumb, channels: 3 } }).png().toBuffer();
  }
  const data = item.image ?? (await fs.readFile(item.nativePath));
  const meta = await sharp(data, { animated: false }).metadata();
  const small = Math.max(meta.width ?? 0, meta.height ?? 0) < thumb / 2;
  const img = await sharp(data, { animated: false })
    .autoOrient()
    .resize(thumb, thumb, { fit: "inside", kernel: small ? "nearest" : "lanczos3" })
    .png()
    .toBuffer({ resolveWithObject: true });
  return sharp(board)
    .composite([{ input: img.data, left: Math.floor((thumb - img.info.width) / 2), top: Math.floor((thumb - img.info.height) / 2) }])
    .png()
    .toBuffer();
}

/**
 * Lays out thumbnails in a grid, each with a numeric badge (stable label) and a
 * filename caption. Unreadable images become grey placeholders and are
 * reported in `errors` rather than failing the sheet.
 */
export async function renderContactSheet(items: ContactSheetItem[], options: ContactSheetOptions = {}): Promise<ContactSheetResult> {
  const thumb = Math.max(48, Math.min(512, Math.round(options.thumbSize ?? 192)));
  const columns = Math.max(1, Math.min(items.length || 1, options.columns ?? Math.min(6, Math.ceil(Math.sqrt(items.length || 1)))));
  const rows = Math.max(1, Math.ceil(items.length / columns));
  const cellW = thumb;
  const cellH = thumb + CAPTION_HEIGHT;
  const width = GAP + columns * (cellW + GAP);
  const height = GAP + rows * (cellH + GAP);
  const errors = new Map<string, string>();
  const board = await sharp(checkerboard(thumb), { raw: { width: thumb, height: thumb, channels: 3 } }).png().toBuffer();

  const layers: OverlayOptions[] = [];
  await Promise.all(
    items.map(async (item, i) => {
      const left = GAP + (i % columns) * (cellW + GAP);
      const top = GAP + Math.floor(i / columns) * (cellH + GAP);
      let tile: Buffer;
      try {
        tile = await renderTile(item, thumb, board);
      } catch (err) {
        errors.set(item.label, errorMessage(err));
        tile = await sharp({ create: { width: thumb, height: thumb, channels: 3, background: "#9a9a9a" } }).png().toBuffer();
      }
      layers.push({ input: tile, left, top });
      const badge = renderBadge(item.label);
      layers.push({ input: badge.data, raw: { width: badge.width, height: badge.height, channels: 4 }, left: left + 4, top: top + 4 });
      const caption = await renderCaption(item.caption, cellW);
      if (caption) layers.push({ input: caption, left, top: top + thumb });
    }),
  );

  const png = await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
    .composite(layers)
    .png({ compressionLevel: 6 })
    .toBuffer();
  return { png, width, height, columns, rows, errors };
}
