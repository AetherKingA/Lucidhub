import { describe, expect, it } from "vitest";
import { estimateEquity } from "../src/shared/equity.ts";

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pct = (hole: string[], board: string[], opponents: number, n = 20000) => {
  const e = estimateEquity(hole, board, opponents, n, seeded(7))!;
  return e.win + e.tie / 2;
};

describe("win chance", () => {
  // Known values against random hands: AA ≈ 85% heads-up, 72o ≈ 35%, AA ≈ 49% four-way.
  it("matches well-known preflop numbers", () => {
    expect(pct(["As", "Ah"], [], 1)).toBeCloseTo(0.85, 1);
    expect(pct(["7c", "2d"], [], 1)).toBeCloseTo(0.35, 1);
    expect(pct(["As", "Ah"], [], 4)).toBeGreaterThan(0.45);
    expect(pct(["As", "Ah"], [], 4)).toBeLessThan(0.6);
  });

  it("is certain with the nuts on the river, and never above 100%", () => {
    const e = estimateEquity(["As", "Ks"], ["Qs", "Js", "Ts", "2h", "3d"], 3, 500, seeded(1))!;
    expect(e.win).toBe(1);
    expect(e.tie).toBe(0);
  });

  it("goes down the more opponents are still in", () => {
    const one = pct(["Kh", "Qh"], ["Kd", "7c", "2s"], 1, 5000);
    const three = pct(["Kh", "Qh"], ["Kd", "7c", "2s"], 3, 5000);
    expect(three).toBeLessThan(one);
  });

  it("counts a board you can't beat as a split", () => {
    // Royal flush on the board: everyone plays it.
    const e = estimateEquity(["2c", "3d"], ["As", "Ks", "Qs", "Js", "Ts"], 2, 300, seeded(3))!;
    expect(e.win).toBe(0);
    expect(e.tie).toBe(1);
  });

  it("returns nothing without real hole cards or opponents", () => {
    expect(estimateEquity(["??", "??"].slice(0, 1), [], 1)).toBeNull();
    expect(estimateEquity(["As", "Ah"], [], 0)).toBeNull();
  });

  it("is fast enough to run on every change", () => {
    const start = performance.now();
    estimateEquity(["As", "Kd"], ["7h", "8h", "9c"], 5, 3000);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});
