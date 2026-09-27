import { describe, expect, it } from "vitest";
import { combine, lexicalScore, queryTokens } from "../../src/search/ranking.ts";
import { cosineScores, topK } from "../../src/search/vector.ts";

describe("ranking", () => {
  it("drops stopwords and duplicates from queries", () => {
    expect(queryTokens("Find a dark medieval sword, the dark one")).toEqual(["dark", "medieval", "sword", "one"]);
  });
  it("scores path word overlap with plural tolerance", () => {
    const t = queryTokens("wooden treasure chest");
    expect(lexicalScore(t, "assets/props/chests/wooden_chest_01.png")).toBeCloseTo(2 / 3);
    expect(lexicalScore(t, "assets/props/barrel.png")).toBe(0);
    expect(lexicalScore([], "a.png")).toBe(0);
    expect(lexicalScore(["ui"], "assets/ui/x.png")).toBe(1);
    expect(lexicalScore(["ui"], "assets/build/x.png")).toBe(0);
  });
  it("keeps visual similarity dominant", () => {
    expect(combine({ visual: 0.12, lexical: 0 })).toBeGreaterThan(combine({ visual: 0.05, lexical: 1 }));
  });
  it("computes cosine against a matrix and a stable top-k", () => {
    const m = { dims: 2, count: 3, paths: ["a", "b", "c"], hashes: ["1", "2", "3"], data: new Float32Array([1, 0, 0, 1, 1, 0]) };
    const s = cosineScores(m, new Float32Array([1, 0]));
    expect(Array.from(s)).toEqual([1, 0, 1]);
    expect(topK(s, 2)).toEqual([0, 2]);
    expect(topK(s, 5, (i) => i !== 0)).toEqual([2, 1]);
  });
  it("rejects queries from a different space", () => {
    const m = { dims: 3, count: 1, paths: ["a"], hashes: ["1"], data: new Float32Array([1, 0, 0]) };
    expect(() => cosineScores(m, new Float32Array([1, 0]))).toThrow();
  });
});
