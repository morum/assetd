/**
 * Renders a waveform (min/max per pixel column) as raw RGB. Used as the
 * visual preview of audio assets in contact sheets: duration and envelope
 * (short impact vs. long ambience) become visible to a multimodal agent.
 */
export function renderWaveform(samples: Float32Array, width: number, height: number): Buffer {
  const img = Buffer.alloc(width * height * 3, 0);
  img.fill(250);
  const mid = Math.floor(height / 2);
  for (let x = 0; x < width; x++) img.set([200, 200, 210], (mid * width + x) * 3);
  if (samples.length === 0) return img;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!));
  const gain = peak > 0 ? 0.95 / peak : 1;
  for (let x = 0; x < width; x++) {
    const start = Math.floor((x * samples.length) / width);
    const end = Math.max(start + 1, Math.floor(((x + 1) * samples.length) / width));
    let lo = 0;
    let hi = 0;
    for (let i = start; i < end && i < samples.length; i++) {
      const v = samples[i]! * gain;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const y0 = Math.max(0, Math.round(mid - hi * (mid - 2)));
    const y1 = Math.min(height - 1, Math.round(mid - lo * (mid - 2)));
    for (let y = y0; y <= y1; y++) img.set([40, 90, 200], (y * width + x) * 3);
  }
  return img;
}
