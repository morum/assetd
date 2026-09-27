import type { VectorMatrix } from "../storage/index-store.ts";

/** Dot products of `query` against every row (rows and query are L2-normalized => cosine). */
export function cosineScores(matrix: VectorMatrix, query: Float32Array): Float32Array {
  if (matrix.count > 0 && query.length !== matrix.dims) {
    throw new Error(`Query has ${query.length} dimensions, index has ${matrix.dims}`);
  }
  const { data, dims, count } = matrix;
  const scores = new Float32Array(count);
  for (let r = 0; r < count; r++) {
    let s = 0;
    const o = r * dims;
    for (let k = 0; k < dims; k++) s += data[o + k]! * query[k]!;
    scores[r] = s;
  }
  return scores;
}

/** Indices of the `k` highest values, descending; ties broken by index for stable output. */
export function topK(values: ArrayLike<number>, k: number, keep: (i: number) => boolean = () => true): number[] {
  const idx: number[] = [];
  for (let i = 0; i < values.length; i++) if (keep(i)) idx.push(i);
  idx.sort((a, b) => values[b]! - values[a]! || a - b);
  return idx.slice(0, Math.max(0, k));
}
