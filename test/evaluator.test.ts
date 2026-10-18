import { describe, expect, it } from "vitest";
import { evaluate } from "../src/shared/engine/evaluator.ts";
import { fullDeck, shuffledDeck } from "../src/shared/engine/cards.ts";

const h = (s: string) => evaluate(s.split(" "));

describe("evaluate", () => {
  it("names every category", () => {
    expect(h("As Ks Qs Js Ts 2c 3d").name).toBe("Straight Flush");
    expect(h("9c 9d 9h 9s Kd 2c 3d").name).toBe("Four of a Kind");
    expect(h("9c 9d 9h Ks Kd 2c 3d").name).toBe("Full House");
    expect(h("2h 7h 9h Jh Kh 2c 3d").name).toBe("Flush");
    expect(h("5c 6d 7h 8s 9d 2c Kd").name).toBe("Straight");
    expect(h("9c 9d 9h As Kd 2c 3d").name).toBe("Three of a Kind");
    expect(h("9c 9d Kh Ks 2d 4c 6d").name).toBe("Two Pair");
    expect(h("9c 9d Ah Ks 2d 4c 6d").name).toBe("Pair");
    expect(h("9c Td Ah Ks 2d 4c 6d").name).toBe("High Card");
  });

  it("orders categories correctly", () => {
    const ladder = [
      "9c Td Ah Ks 2d 4c 6d",
      "9c 9d Ah Ks 2d 4c 6d",
      "9c 9d Kh Ks 2d 4c 6d",
      "9c 9d 9h As Kd 2c 3d",
      "5c 6d 7h 8s 9d 2c Kd",
      "2h 7h 9h Jh Kh 2c 3d",
      "9c 9d 9h Ks Kd 2c 3d",
      "9c 9d 9h 9s Kd 2c 3d",
      "As Ks Qs Js Ts 2c 3d",
    ].map((s) => h(s).score);
    for (let i = 1; i < ladder.length; i++) expect(ladder[i]).toBeGreaterThan(ladder[i - 1]!);
  });

  it("treats A-2-3-4-5 as the lowest straight", () => {
    const wheel = h("Ac 2d 3h 4s 5d Kc Qd");
    const sixHigh = h("2d 3h 4s 5d 6c Kc Qd");
    expect(wheel.name).toBe("Straight");
    expect(sixHigh.score).toBeGreaterThan(wheel.score);
    expect(h("Ah 2h 3h 4h 5h Kc Qd").name).toBe("Straight Flush");
  });

  it("does not wrap straights around the ace", () => {
    expect(h("Qc Kd Ah 2s 3d 8c 9d").name).toBe("High Card");
  });

  it("uses kickers", () => {
    expect(h("Ac Ad Kh 7s 2d 3c 4d").score).toBeGreaterThan(h("As Ah Qh 7c 2d 3c 4d").score);
    expect(h("Kc Kd 5h 5s Ad 2c 3d").score).toBeGreaterThan(h("Ks Kh 5c 5d Qd 2c 3d").score);
    // Full house is ranked by the trips first.
    expect(h("3c 3d 3h 2s 2d 9c Td").score).toBeGreaterThan(h("2c 2h 2s Ac Ad 9h Th").score);
  });

  it("ties identical boards", () => {
    // Board plays: A-K-Q-J-T straight for both.
    const board = "Ah Kd Qc Js Th";
    expect(h(`2c 3d ${board}`).score).toBe(h(`4c 5d ${board}`).score);
  });

  it("picks the best five of seven", () => {
    // Flush beats the straight also present.
    expect(h("6h 7h 8h 9c Th 2h 3d").name).toBe("Flush");
  });
});

describe("shuffledDeck", () => {
  it("is a permutation of the full deck", () => {
    const d = shuffledDeck();
    expect(d).toHaveLength(52);
    expect([...d].sort()).toEqual(fullDeck().sort());
  });
});
