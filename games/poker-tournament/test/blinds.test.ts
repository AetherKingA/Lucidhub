import { describe, expect, it } from "vitest";
import { BLIND_PRESETS, StructureError, cleanLevels } from "../src/server/tournament/structure.ts";

describe("blind presets", () => {
  it("are all valid structures that only go up", () => {
    for (const p of BLIND_PRESETS) {
      expect(cleanLevels(p.levels)).toEqual(p.levels);
      expect(p.levels.length).toBeGreaterThan(10);
    }
  });

  it("differ in pace", () => {
    const by = Object.fromEntries(BLIND_PRESETS.map((p) => [p.id, p]));
    expect(by.turbo!.levels[0]!.minutes).toBeLessThan(by.standard!.levels[0]!.minutes);
    expect(by.hyper!.set.startingStack).toBeLessThan(by.deep!.set.startingStack!);
    expect(by.hyper!.levels[1]!.ante).toBeGreaterThan(0);
  });
});

describe("custom blind structures", () => {
  const lv = (smallBlind: number, bigBlind: number, ante = 0, minutes = 10) => ({ smallBlind, bigBlind, ante, minutes });

  it("rounds to whole chips and keeps valid levels", () => {
    expect(cleanLevels([{ smallBlind: "25", bigBlind: 50.4, minutes: "8" }])).toEqual([lv(25, 50, 0, 8)]);
  });

  it("names the level that's wrong", () => {
    expect(() => cleanLevels([])).toThrow(StructureError);
    expect(() => cleanLevels([lv(50, 25)])).toThrow(/Level 1: the big blind must be at least the small blind/);
    expect(() => cleanLevels([lv(25, 50), lv(25, 50, 60)])).toThrow(/Level 2: the ante/);
    expect(() => cleanLevels([lv(25, 50), lv(50, 100, 0, 0)])).toThrow(/Level 2: levels must last/);
    expect(() => cleanLevels([lv(25, 50), lv(100, 200), lv(50, 100)])).toThrow(/Level 3: blinds can't go down/);
    expect(() => cleanLevels([{ smallBlind: 25 }])).toThrow(/fill in every number/);
    expect(() => cleanLevels(Array.from({ length: 61 }, (_, i) => lv(i + 1, i + 1)))).toThrow(/60 levels/);
  });
});
