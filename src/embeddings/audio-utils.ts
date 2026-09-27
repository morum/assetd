/** Mixes channels down to mono by averaging. */
export function downmix(channels: Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  const out = new Float32Array(first.length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] = out[i]! + (ch[i] ?? 0);
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / channels.length;
  return out;
}

/**
 * Linear-interpolation resampler. When downsampling, a box filter over the
 * source span limits aliasing; good enough for embedding models, which only
 * see a 50 Hz–14 kHz mel spectrogram.
 */
export function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const ratio = from / to;
  const length = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(length);
  if (ratio > 1) {
    for (let i = 0; i < length; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j]!;
      out[i] = sum / (end - start);
    }
    return out;
  }
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = input[j] ?? 0;
    const b = input[j + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Peak and RMS level in dBFS (null for digital silence). */
export function levels(samples: Float32Array): { peakDb: number | null; rmsDb: number | null } {
  let peak = 0;
  let sq = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]!);
    if (v > peak) peak = v;
    sq += v * v;
  }
  const rms = samples.length ? Math.sqrt(sq / samples.length) : 0;
  const db = (x: number) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : null);
  return { peakDb: db(peak), rmsDb: db(rms) };
}
