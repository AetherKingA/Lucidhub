import { describe, expect, it } from "vitest";
import {
  GROUND_Y, PIPE_GAP, autopilot, compareRuns, pipeAt, pipesBetween, simulate, trace, validFlaps,
} from "../src/shared/engine/flappy.ts";

describe("course", () => {
  it("gives the same pipes for the same seed, and different ones for another seed", () => {
    const a = [0, 1, 2, 3, 4].map((i) => pipeAt(42, i).gapY);
    expect([0, 1, 2, 3, 4].map((i) => pipeAt(42, i).gapY)).toEqual(a);
    expect([0, 1, 2, 3, 4].map((i) => pipeAt(43, i).gapY)).not.toEqual(a);
  });

  it("keeps every gap above the ground and below the top", () => {
    for (let i = 0; i < 500; i++) {
      const { gapY } = pipeAt(7, i);
      expect(gapY - PIPE_GAP / 2).toBeGreaterThan(0);
      expect(gapY + PIPE_GAP / 2).toBeLessThan(GROUND_Y);
    }
  });

  it("lists the pipes on screen", () => {
    expect(pipesBetween(1, 0, 288)).toEqual([]);
    expect(pipesBetween(1, 300, 600).map((p) => p.index)).toEqual([0, 1]);
  });
});

describe("simulate", () => {
  it("falls to the ground with no flaps", () => {
    const r = simulate(1, []);
    expect(r).toMatchObject({ score: 0, crashed: true });
    expect(r.distance).toBeGreaterThan(20);
    expect(r.distance).toBeLessThan(120);
  });

  it("is deterministic", () => {
    const flaps = autopilot(99, 5000);
    expect(simulate(99, flaps)).toEqual(simulate(99, flaps));
  });

  it("lets a good pilot pass many pipes", () => {
    const flaps = autopilot(5, 60 * 60);
    const r = simulate(5, flaps, 60 * 60);
    expect(r.score).toBeGreaterThan(20);
  });

  it("cuts a run off at maxTicks and counts the distance so far", () => {
    const flaps = autopilot(5, 60 * 60);
    expect(simulate(5, flaps, 600)).toMatchObject({ distance: 600, crashed: false });
  });

  it("a run flown on one course doesn't survive another", () => {
    const flaps = autopilot(5, 60 * 60);
    expect(simulate(6, flaps).distance).toBeLessThan(simulate(5, flaps).distance);
  });

  it("trace matches simulate", () => {
    const flaps = autopilot(3, 3000, 0.6, () => 0.3);
    const t = trace(3, flaps);
    expect(t.result).toEqual(simulate(3, flaps));
    expect(t.y.length).toBe(t.result.distance + 1);
  });
});

describe("validFlaps", () => {
  it("accepts increasing whole ticks", () => {
    expect(validFlaps([0, 5, 30])).toBe(true);
    expect(validFlaps([])).toBe(true);
  });
  it("rejects anything else", () => {
    expect(validFlaps([5, 5])).toBe(false);
    expect(validFlaps([5, 3])).toBe(false);
    expect(validFlaps([1.5])).toBe(false);
    expect(validFlaps([-1])).toBe(false);
    expect(validFlaps("1,2")).toBe(false);
    expect(validFlaps([10], 10)).toBe(false);
  });
});

it("ranks further runs first, then earlier ones", () => {
  const runs = [
    { name: "b", distance: 100, setAt: 2 },
    { name: "a", distance: 300, setAt: 9 },
    { name: "c", distance: 100, setAt: 1 },
  ];
  expect(runs.sort(compareRuns).map((r) => r.name)).toEqual(["a", "c", "b"]);
});
