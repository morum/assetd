import sharp from "sharp";
import type { ModelPrimitive, ModelScene } from "../processors/model3d/model-scene.ts";
import { boundingBox } from "../processors/model3d/model-scene.ts";

/**
 * Minimal software rasterizer for model previews: orthographic camera, z-buffer,
 * double-sided Lambert shading, base color × texture × vertex color, white
 * background. Pure TypeScript, no GPU, identical output on every platform.
 * Orthographic projection makes affine UV interpolation exact.
 */

export interface View {
  name: string;
  /** Degrees around the up (Y) axis; 0 looks at the model's front (+Z toward the camera). */
  azimuth: number;
  /** Degrees above the horizon. */
  elevation: number;
}

export const VIEWS: Record<string, View> = {
  front: { name: "front", azimuth: 0, elevation: 0 },
  back: { name: "back", azimuth: 180, elevation: 0 },
  left: { name: "left", azimuth: -90, elevation: 0 },
  right: { name: "right", azimuth: 90, elevation: 0 },
  top: { name: "top", azimuth: 0, elevation: 89 },
  perspective1: { name: "perspective1", azimuth: 35, elevation: 25 },
  perspective2: { name: "perspective2", azimuth: -145, elevation: 25 },
  perspective3: { name: "perspective3", azimuth: 125, elevation: 25 },
  perspective4: { name: "perspective4", azimuth: -55, elevation: 25 },
};

interface Texture {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface RenderOptions {
  size: number;
  /** Supersampling factor (rendered at size × ss, then downscaled). */
  supersample?: number;
}

export interface RenderedView {
  view: View;
  /** RGB, `size × size`. */
  rgb: Uint8Array;
  size: number;
}

const toSrgb = (linear: number) => (linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055);

/** Decodes each distinct texture once to RGBA. Unreadable textures fall back to untextured. */
async function decodeTextures(scene: ModelScene): Promise<Map<Uint8Array, Texture | null>> {
  const out = new Map<Uint8Array, Texture | null>();
  for (const p of scene.primitives) {
    const bytes = p.texture?.data;
    if (!bytes || out.has(bytes)) continue;
    try {
      const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      out.set(bytes, { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height });
    } catch {
      out.set(bytes, null);
    }
  }
  return out;
}

function sampleTexture(t: Texture, u: number, v: number, out: [number, number, number]): number {
  // Repeat wrapping, nearest texel: crisp for low-poly palette textures.
  const x = Math.min(t.width - 1, Math.max(0, Math.floor((u - Math.floor(u)) * t.width)));
  const y = Math.min(t.height - 1, Math.max(0, Math.floor((v - Math.floor(v)) * t.height)));
  const o = (y * t.width + x) * 4;
  out[0] = t.data[o]! / 255;
  out[1] = t.data[o + 1]! / 255;
  out[2] = t.data[o + 2]! / 255;
  return t.data[o + 3]! / 255;
}

/** Camera basis for an orbit view: right, up, forward (toward the model). */
function basis(view: View): { r: number[]; u: number[]; f: number[] } {
  const az = (view.azimuth * Math.PI) / 180;
  const el = (view.elevation * Math.PI) / 180;
  // Camera position direction (from the model toward the camera).
  const c = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
  const f = [-c[0]!, -c[1]!, -c[2]!];
  const worldUp = Math.abs(view.elevation) > 80 ? [0, 0, -1] : [0, 1, 0];
  const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const norm = (a: number[]) => {
    const n = Math.hypot(a[0]!, a[1]!, a[2]!) || 1;
    return a.map((x) => x / n);
  };
  const r = norm(cross(f, worldUp));
  const u = cross(r, f);
  return { r, u, f };
}

export async function renderViews(scene: ModelScene, views: View[], options: RenderOptions): Promise<RenderedView[]> {
  const box = boundingBox(scene);
  const ss = Math.max(1, Math.round(options.supersample ?? 2));
  const W = options.size * ss;
  const textures = await decodeTextures(scene);
  const results: RenderedView[] = [];
  const center = box ? box.min.map((v, i) => (v + box.max[i]!) / 2) : [0, 0, 0];
  const radius = box ? Math.max(1e-9, Math.hypot(...box.max.map((v, i) => v - box.min[i]!)) / 2) : 1;
  const light = [0.4, 0.6, 0.7]; // in camera space: from upper left, slightly behind the viewer
  const ln = Math.hypot(light[0]!, light[1]!, light[2]!);

  for (const view of views) {
    const color = new Float32Array(W * W * 3).fill(1);
    const depth = new Float32Array(W * W).fill(Infinity);
    const { r, u, f } = basis(view);
    // Fit the projected footprint (not the bounding sphere) with an 8% margin.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const projected: Float32Array[] = scene.primitives.map((p) => {
      const out = new Float32Array((p.positions.length / 3) * 3);
      for (let i = 0; i < p.positions.length; i += 3) {
        const x = p.positions[i]! - center[0]!;
        const y = p.positions[i + 1]! - center[1]!;
        const z = p.positions[i + 2]! - center[2]!;
        const px = x * r[0]! + y * r[1]! + z * r[2]!;
        const py = x * u[0]! + y * u[1]! + z * u[2]!;
        out[i] = px;
        out[i + 1] = py;
        out[i + 2] = x * f[0]! + y * f[1]! + z * f[2]!;
        if (Number.isFinite(px) && Number.isFinite(py)) {
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
      }
      return out;
    });
    const extent = Math.max(maxX - minX, maxY - minY, radius * 1e-3);
    const scale = (W * 0.84) / extent;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const sx = (x: number) => (x - midX) * scale + W / 2;
    const sy = (y: number) => W / 2 - (y - midY) * scale;

    const texel: [number, number, number] = [1, 1, 1];
    scene.primitives.forEach((p: ModelPrimitive, pi) => {
      const v = projected[pi]!;
      const tex = p.texture?.data ? textures.get(p.texture.data) ?? null : null;
      const base = [toSrgb(p.baseColor[0]), toSrgb(p.baseColor[1]), toSrgb(p.baseColor[2])];
      for (let t = 0; t + 2 < p.indices.length; t += 3) {
        const i0 = p.indices[t]!, i1 = p.indices[t + 1]!, i2 = p.indices[t + 2]!;
        const x0 = sx(v[i0 * 3]!), y0 = sy(v[i0 * 3 + 1]!), z0 = v[i0 * 3 + 2]!;
        const x1 = sx(v[i1 * 3]!), y1 = sy(v[i1 * 3 + 1]!), z1 = v[i1 * 3 + 2]!;
        const x2 = sx(v[i2 * 3]!), y2 = sy(v[i2 * 3 + 1]!), z2 = v[i2 * 3 + 2]!;
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if (!Number.isFinite(area) || Math.abs(area) < 1e-12) continue;
        // Face normal in camera space (right, up, forward), for double-sided Lambert.
        const ax = v[i1 * 3]! - v[i0 * 3]!, ay = v[i1 * 3 + 1]! - v[i0 * 3 + 1]!, az = v[i1 * 3 + 2]! - v[i0 * 3 + 2]!;
        const bx = v[i2 * 3]! - v[i0 * 3]!, by = v[i2 * 3 + 1]! - v[i0 * 3 + 1]!, bz = v[i2 * 3 + 2]! - v[i0 * 3 + 2]!;
        const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        const lambert = Math.abs((nx * light[0]! + ny * light[1]! - nz * light[2]!) / (nl * ln));
        const shade = 0.38 + 0.62 * lambert;
        const minPx = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
        const maxPx = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
        const minPy = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
        const maxPy = Math.min(W - 1, Math.ceil(Math.max(y0, y1, y2)));
        for (let py = minPy; py <= maxPy; py++) {
          const cy = py + 0.5;
          for (let px = minPx; px <= maxPx; px++) {
            const cx = px + 0.5;
            const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
            const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
            const w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const z = w0 * z0 + w1 * z1 + w2 * z2;
            const di = py * W + px;
            if (z >= depth[di]!) continue;
            let cr = base[0]!, cg = base[1]!, cb = base[2]!;
            if (tex && p.uvs) {
              const tu = w0 * p.uvs[i0 * 2]! + w1 * p.uvs[i1 * 2]! + w2 * p.uvs[i2 * 2]!;
              const tv = w0 * p.uvs[i0 * 2 + 1]! + w1 * p.uvs[i1 * 2 + 1]! + w2 * p.uvs[i2 * 2 + 1]!;
              const alpha = sampleTexture(tex, tu, tv, texel);
              if (alpha < 0.5) continue; // cut-out foliage, fences
              cr *= texel[0];
              cg *= texel[1];
              cb *= texel[2];
            }
            if (p.colors) {
              cr *= w0 * p.colors[i0 * 3]! + w1 * p.colors[i1 * 3]! + w2 * p.colors[i2 * 3]!;
              cg *= w0 * p.colors[i0 * 3 + 1]! + w1 * p.colors[i1 * 3 + 1]! + w2 * p.colors[i2 * 3 + 1]!;
              cb *= w0 * p.colors[i0 * 3 + 2]! + w1 * p.colors[i1 * 3 + 2]! + w2 * p.colors[i2 * 3 + 2]!;
            }
            depth[di] = z;
            color[di * 3] = cr * shade;
            color[di * 3 + 1] = cg * shade;
            color[di * 3 + 2] = cb * shade;
          }
        }
      }
    });

    const big = new Uint8Array(W * W * 3);
    for (let i = 0; i < big.length; i++) big[i] = Math.max(0, Math.min(255, Math.round(color[i]! * 255)));
    const rgb =
      ss === 1
        ? big
        : new Uint8Array(await sharp(big, { raw: { width: W, height: W, channels: 3 } }).resize(options.size, options.size, { kernel: "cubic" }).raw().toBuffer());
    results.push({ view, rgb, size: options.size });
  }
  return results;
}
