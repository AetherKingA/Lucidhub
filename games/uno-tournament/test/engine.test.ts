import { describe, expect, it } from "vitest";
import { cardPoints, fullDeck, handPoints, isCard } from "../src/shared/engine/cards.ts";
import {
  type GameState,
  IllegalActionError,
  applyAction,
  autoAction,
  cardCount,
  current,
  legalActions,
  removePlayer,
  startGame,
  topCard,
} from "../src/shared/engine/game.ts";

/** A hand with chosen cards. The draw pile is whatever's left of a deck, so totals stay at 108. */
function setup(hands: string[][], top: string, opts: Partial<GameState> = {}): GameState {
  const pile = fullDeck();
  const take = (c: string) => {
    const i = pile.indexOf(c);
    if (i < 0) throw new Error(`no ${c} left`);
    pile.splice(i, 1);
    return c;
  };
  const players = hands.map((h, i) => ({ playerId: `p${i}`, seat: i, hand: h.map(take), calledUno: false }));
  const discard = [take(top)];
  return {
    players,
    drawPile: pile,
    discard,
    color: (top.length === 2 && top !== "W4" ? top[0] : "r") as GameState["color"],
    turn: 0,
    direction: 1,
    pendingDraw: 0,
    drawn: null,
    unoVulnerable: null,
    stacking: false,
    winner: null,
    log: [],
    rng: 1,
    ...opts,
  };
}

const play = (g: GameState, pid: string, card: string, extra: object = {}) => applyAction(g, pid, { type: "play", card, ...extra });

describe("cards", () => {
  it("has the official 108-card deck", () => {
    const deck = fullDeck();
    expect(deck).toHaveLength(108);
    expect(deck.filter((c) => c === "W")).toHaveLength(4);
    expect(deck.filter((c) => c === "W4")).toHaveLength(4);
    expect(deck.filter((c) => c === "r0")).toHaveLength(1);
    expect(deck.filter((c) => c === "b7")).toHaveLength(2);
    expect(deck.filter((c) => c.endsWith("D") && c !== "W4")).toHaveLength(8);
    expect(deck.every(isCard)).toBe(true);
  });

  it("scores cards left in a hand", () => {
    expect(cardPoints("g7")).toBe(7);
    expect(cardPoints("rS")).toBe(20);
    expect(cardPoints("W4")).toBe(50);
    expect(handPoints(["r0", "yD", "W"])).toBe(70);
  });
});

describe("dealing", () => {
  it("deals seven each, never starts on a wild, and keeps all 108 cards", () => {
    for (let seed = 1; seed < 200; seed++) {
      const g = startGame({ players: [0, 1, 2, 3].map((i) => ({ playerId: `p${i}`, seat: i })), dealer: 0, stacking: false, seed });
      expect(cardCount(g)).toBe(108);
      expect(topCard(g)).not.toMatch(/^W/);
      const sizes = g.players.map((p) => p.hand.length).sort();
      // Seven each, except a starting Draw Two hands the first player two more.
      expect(sizes.filter((n) => n === 7).length).toBeGreaterThanOrEqual(3);
    }
  });

  it("is repeatable from the seed", () => {
    const opts = { players: [0, 1, 2].map((i) => ({ playerId: `p${i}`, seat: i })), dealer: 1, stacking: false, seed: 42 };
    expect(startGame(opts)).toEqual(startGame(opts));
  });

  it("shuffles with the secure generator when there's no seed", () => {
    const opts = { players: [0, 1, 2].map((i) => ({ playerId: `p${i}`, seat: i })), dealer: 1, stacking: false };
    const a = startGame(opts);
    expect(a.rng).toBeNull();
    expect(cardCount(a)).toBe(108);
    expect(startGame(opts).drawPile).not.toEqual(a.drawPile);
  });
});

describe("playing", () => {
  it("matches by color or value and moves the turn on", () => {
    const g = setup([["r5", "b7"], ["g1"], ["y2"]], "r3");
    expect(legalActions(g)!.playable).toEqual(["r5"]);
    const next = play(g, "p0", "r5");
    expect(topCard(next)).toBe("r5");
    expect(next.turn).toBe(1);
    expect(() => play(g, "p0", "b7")).toThrow(IllegalActionError);
    expect(() => play(g, "p1", "g1")).toThrow("not your turn");
    // Value match changes color.
    const v = play(setup([["b3", "r1", "r2"], ["g1"]], "r3"), "p0", "b3");
    expect(v.color).toBe("b");
  });

  it("does not change the state it was given", () => {
    const g = setup([["r5", "b7"], ["g1"]], "r3");
    const copy = structuredClone(g);
    play(g, "p0", "r5");
    expect(g).toEqual(copy);
  });

  it("Skip skips, Reverse reverses (and skips with two players)", () => {
    const skip = play(setup([["rS", "b1"], ["g1"], ["y2"]], "r3"), "p0", "rS");
    expect(skip.turn).toBe(2);
    const rev = play(setup([["rR", "b1"], ["g1"], ["y2"]], "r3"), "p0", "rR");
    expect(rev.direction).toBe(-1);
    expect(rev.turn).toBe(2);
    const rev2 = play(setup([["rR", "b1"], ["g1"]], "r3"), "p0", "rR");
    expect(rev2.turn).toBe(0);
  });

  it("Draw Two makes the next player draw two and lose their turn", () => {
    const g = play(setup([["rD", "b1"], ["g1"], ["y2"]], "r3"), "p0", "rD");
    expect(g.players[1]!.hand).toHaveLength(3);
    expect(g.turn).toBe(2);
    expect(cardCount(g)).toBe(108);
  });

  it("wilds need a color; Wild Draw Four only without the current color", () => {
    const g = setup([["W", "W4", "r1", "b2"], ["g1"], ["y2"]], "r3");
    expect(() => play(g, "p0", "W")).toThrow("Pick a color");
    const w = play(g, "p0", "W", { color: "g" });
    expect(w.color).toBe("g");
    expect(legalActions(g)!.playable).not.toContain("W4");
    expect(() => play(g, "p0", "W4", { color: "b" })).toThrow("no red cards");

    const ok = play(setup([["W4", "b2", "b3"], ["g1"], ["y2"]], "r3"), "p0", "W4", { color: "b" });
    expect(ok.players[1]!.hand).toHaveLength(5);
    expect(ok.turn).toBe(2);
    expect(ok.color).toBe("b");
  });

  it("a wild on top only matches its chosen color", () => {
    const g = setup([["W", "g5"], ["b1"], ["y2"]], "r3");
    const w = play(g, "p0", "W", { color: "y" });
    expect(legalActions(w)!.playable).toEqual([]);
  });

  it("draw one: play it if it fits, otherwise the turn ends", () => {
    const g = setup([["b1"], ["g1"]], "r3");
    g.drawPile.push("r9");
    const d = applyAction(g, "p0", { type: "draw" });
    expect(d.turn).toBe(0);
    expect(d.drawn).toBe("r9");
    expect(legalActions(d)).toMatchObject({ playable: ["r9"], canDraw: false, canPass: true });
    expect(() => applyAction(d, "p0", { type: "draw" })).toThrow();
    expect(play(d, "p0", "r9").turn).toBe(1);
    expect(applyAction(d, "p0", { type: "pass" }).turn).toBe(1);

    const g2 = setup([["b1"], ["g1"]], "r3");
    g2.drawPile.push("y9");
    const d2 = applyAction(g2, "p0", { type: "draw" });
    expect(d2.turn).toBe(1);
    expect(d2.drawn).toBeNull();
    expect(() => applyAction(g2, "p0", { type: "pass" })).toThrow("Draw a card first");
  });

  it("only the drawn card can be played after drawing", () => {
    const g = setup([["r1"], ["g1"]], "r3");
    g.drawPile.push("r9");
    const d = applyAction(g, "p0", { type: "draw" });
    expect(() => play(d, "p0", "r1")).toThrow("just drew");
  });

  it("reshuffles the discards when the draw pile runs out", () => {
    const g = setup([["b1"], ["g1"]], "r3");
    // Everything not in a hand is in the discards, under the top card.
    g.discard = [...g.drawPile, ...g.discard];
    g.drawPile = [];
    const d = applyAction(g, "p0", { type: "draw" });
    expect(cardCount(d)).toBe(108);
    expect(d.players[0]!.hand).toHaveLength(2);
    expect(d.discard).toEqual(["r3"]);
  });

  it("going out wins the hand", () => {
    const g = play(setup([["r5"], ["g1"]], "r3"), "p0", "r5");
    expect(g.winner).toBe("p0");
    expect(legalActions(g)).toBeNull();
    expect(() => applyAction(g, "p1", { type: "draw" })).toThrow("over");
  });
});

describe("UNO", () => {
  it("forgetting UNO can be caught before the next player acts", () => {
    const g = play(setup([["r5", "r6"], ["g1", "g2"], ["y2"]], "r3"), "p0", "r5");
    expect(g.unoVulnerable).toBe("p0");
    const caught = applyAction(g, "p2", { type: "catch", playerId: "p0" });
    expect(caught.players[0]!.hand).toHaveLength(3);
    expect(caught.unoVulnerable).toBeNull();
    expect(() => applyAction(caught, "p2", { type: "catch", playerId: "p0" })).toThrow("Too late");
    expect(caught.turn).toBe(1); // catching doesn't change whose turn it is

    // Once the next player acts, it's too late.
    const moved = applyAction(g, "p1", { type: "draw" });
    expect(moved.unoVulnerable).toBeNull();
    expect(() => applyAction(moved, "p2", { type: "catch", playerId: "p0" })).toThrow("Too late");
  });

  it("calling UNO with the play, or right after, makes you safe", () => {
    const g = play(setup([["r5", "r6"], ["g1"], ["y2"]], "r3"), "p0", "r5", { uno: true });
    expect(g.unoVulnerable).toBeNull();
    const late = applyAction(play(setup([["r5", "r6"], ["g1"], ["y2"]], "r3"), "p0", "r5"), "p0", { type: "uno" });
    expect(late.unoVulnerable).toBeNull();
    expect(() => applyAction(late, "p1", { type: "catch", playerId: "p0" })).toThrow();
    // Calling early (two cards, before playing) counts too.
    const early = applyAction(setup([["r5", "r6"], ["g1"], ["y2"]], "r3"), "p0", { type: "uno" });
    expect(play(early, "p0", "r5").unoVulnerable).toBeNull();
    expect(() => applyAction(setup([["r5", "r6", "r7"], ["g1"]], "r3"), "p0", { type: "uno" })).toThrow();
  });
});

describe("stacking", () => {
  it("off: no passing the penalty on", () => {
    const g = play(setup([["rD", "b1"], ["gD", "g2"], ["y2"]], "r3"), "p0", "rD");
    expect(g.pendingDraw).toBe(0);
    expect(g.turn).toBe(2);
  });

  it("on: Draw Two stacks onto Draw Two, Wild Draw Four onto either, last one draws the total", () => {
    const g0 = setup([["rD", "b1"], ["gD", "g2"], ["W4", "y2"], ["y3", "y4"]], "r3", { stacking: true });
    const g1 = play(g0, "p0", "rD");
    expect(g1).toMatchObject({ pendingDraw: 2, turn: 1 });
    expect(legalActions(g1)!.playable).toEqual(["gD"]);
    expect(() => play(g1, "p1", "g2")).toThrow("Stack a draw card or draw 2");
    const g2 = play(g1, "p1", "gD");
    expect(g2).toMatchObject({ pendingDraw: 4, turn: 2 });
    const g3 = play(g2, "p2", "W4", { color: "y" });
    expect(g3).toMatchObject({ pendingDraw: 8, turn: 3 });
    expect(legalActions(g3)!.playable).toEqual([]);
    const g4 = applyAction(g3, "p3", { type: "draw" });
    expect(g4.players[3]!.hand).toHaveLength(10);
    expect(g4).toMatchObject({ pendingDraw: 0, turn: 0 });
  });

  it("on: Draw Two can't go on a Wild Draw Four", () => {
    const g = play(setup([["W4", "b1"], ["gD", "g2"], ["y2"]], "r3", { stacking: true }), "p0", "W4", { color: "g" });
    expect(legalActions(g)!.playable).toEqual([]);
  });
});

describe("removing a player and auto-play", () => {
  it("removes a kicked player and keeps the turn sensible", () => {
    const g = setup([["r1"], ["g1"], ["y2"]], "r3");
    const r = removePlayer(g, "p0");
    expect(r.players.map((p) => p.playerId)).toEqual(["p1", "p2"]);
    expect(current(r).playerId).toBe("p1");
    expect(cardCount(r)).toBe(108);
    const last = removePlayer(r, "p1");
    expect(last.winner).toBe("p2");
  });

  it("auto-play always finishes a game", () => {
    for (let seed = 1; seed <= 60; seed++) {
      let g = startGame({ players: [0, 1, 2, 3, 4].map((i) => ({ playerId: `p${i}`, seat: i })), dealer: seed % 5, stacking: seed % 2 === 0, seed });
      let steps = 0;
      while (!g.winner && steps++ < 5000) g = applyAction(g, current(g).playerId, autoAction(g));
      expect(g.winner).not.toBeNull();
      expect(cardCount(g)).toBe(108);
    }
  });
});
