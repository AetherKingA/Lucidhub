import { describe, expect, it } from "vitest";
import { amountAt, positionOf, sliderPositions, snapRaise } from "../src/shared/betSizing.ts";

// Level 100/200 with a 20 ante: the step is 100 and a 4,850 stack has 4,830 left, off the step grid.
const range = { min: 400, max: 4830, step: 100 };

describe("snapRaise", () => {
  it("keeps the exact all-in when the stack is off the step grid", () => {
    // The old rounding sent 4,800 here and left 30 chips behind.
    expect(snapRaise(4830, range)).toBe(4830);
  });

  it("reaches all-in when stepping up from just below it", () => {
    expect(snapRaise(4800, range)).toBe(4800);
    expect(snapRaise(4800 + range.step, range)).toBe(4830);
  });

  it("treats anything typed above the stack as all-in", () => {
    expect(snapRaise(99_999, range)).toBe(4830);
  });

  it("keeps the exact minimum", () => {
    expect(snapRaise(0, range)).toBe(400);
    expect(snapRaise(400, range)).toBe(400);
    const oddMin = { ...range, min: 333 };
    expect(snapRaise(333, oddMin)).toBe(333);
  });

  it("snaps amounts in between to the step", () => {
    expect(snapRaise(1234, range)).toBe(1200);
    expect(snapRaise(1260, range)).toBe(1300);
  });

  it("gives the same answer when applied twice", () => {
    for (let v = 0; v <= 5000; v += 7) expect(snapRaise(snapRaise(v, range), range)).toBe(snapRaise(v, range));
  });

  it("never lands a few chips short of all-in, for any stack", () => {
    for (let max = 401; max < 20_000; max += 7) {
      const r = { min: 400, max, step: 100 };
      expect(snapRaise(max, r)).toBe(max);
      expect(amountAt(sliderPositions(r), r)).toBe(max);
    }
  });
});

describe("slider positions", () => {
  it("puts exactly all-in at the far right", () => {
    expect(sliderPositions(range)).toBe(45);
    expect(amountAt(45, range)).toBe(4830);
    expect(amountAt(44, range)).toBe(4800);
    expect(amountAt(0, range)).toBe(400);
  });

  it("has no extra position when the stack is on the grid", () => {
    const onGrid = { min: 400, max: 4800, step: 100 };
    expect(sliderPositions(onGrid)).toBe(44);
    expect(amountAt(44, onGrid)).toBe(4800);
  });

  it("maps amounts back to positions", () => {
    expect(positionOf(400, range)).toBe(0);
    expect(positionOf(4800, range)).toBe(44);
    expect(positionOf(4830, range)).toBe(45);
  });
});
