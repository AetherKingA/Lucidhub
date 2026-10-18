import { describe, expect, it } from "vitest";
import { fullDeck, type Card } from "../src/shared/engine/cards.ts";
import {
  type Action,
  type HandConfig,
  type HandState,
  applyAction,
  legalActions,
  startHand,
  viewFor,
} from "../src/shared/engine/hand.ts";

/**
 * Builds a deck that deals the given hole cards (by seat) and board. Deal order is two rounds
 * starting left of the button, then burn/flop/burn/turn/burn/river.
 */
function stackedDeck(config: HandConfig, holes: Record<number, string>, board = "2c 7d 9h Js 3s"): Card[] {
  const seats = config.seats.flatMap((s, i) => (s && s.stack > 0 ? [i] : []));
  const btn = seats.indexOf(config.button);
  const order = seats.map((_, k) => seats[(btn + 1 + k) % seats.length]!);
  const hole = (seat: number) => (holes[seat] ?? "").split(" ").filter(Boolean);
  const wanted: (Card | null)[] = [];
  for (let r = 0; r < 2; r++) for (const seat of order) wanted.push(hole(seat)[r] ?? null);
  const b = board.split(" ");
  wanted.push(null, b[0]!, b[1]!, b[2]!, null, b[3]!, null, b[4]!);
  const used = new Set(wanted.filter(Boolean));
  const filler = fullDeck().filter((c) => !used.has(c));
  return [...wanted.map((c) => c ?? filler.shift()!), ...filler];
}

function table(stacks: number[], opts: Partial<HandConfig> = {}): HandConfig {
  return {
    seats: stacks.map((stack, i) => ({ playerId: `p${i}`, stack })),
    button: 0,
    smallBlind: 50,
    bigBlind: 100,
    ante: 0,
    ...opts,
  };
}

function play(state: HandState, ...moves: [string, Action][]): HandState {
  for (const [id, a] of moves) state = applyAction(state, id, a);
  return state;
}

const fold = { type: "fold" } as const;
const check = { type: "check" } as const;
const call = { type: "call" } as const;
const raise = (to: number) => ({ type: "raise", to }) as const;
const stack = (s: HandState, id: string) => s.players.find((p) => p.playerId === id)!.stack;
const total = (s: HandState) => s.players.reduce((t, p) => t + p.stack + p.contributed * (s.result ? 0 : 1), 0);

describe("blinds and turn order", () => {
  it("posts blinds left of the button and starts action under the gun", () => {
    const s = startHand(table([1000, 1000, 1000, 1000]), stackedDeck(table([1000, 1000, 1000, 1000]), {}));
    expect(stack(s, "p1")).toBe(950);
    expect(stack(s, "p2")).toBe(900);
    expect(legalActions(s)!.playerId).toBe("p3");
    expect(s.players.every((p) => p.holeCards.length === 2)).toBe(true);
  });

  it("heads-up: button posts the small blind, acts first preflop and last postflop", () => {
    const cfg = table([1000, 1000]);
    let s = startHand(cfg, stackedDeck(cfg, {}));
    expect(stack(s, "p0")).toBe(950);
    expect(stack(s, "p1")).toBe(900);
    expect(legalActions(s)!.playerId).toBe("p0");
    s = play(s, ["p0", call], ["p1", check]);
    expect(s.street).toBe("flop");
    expect(legalActions(s)!.playerId).toBe("p1");
  });

  it("gives the big blind the option when everyone limps", () => {
    const cfg = table([1000, 1000, 1000]);
    let s = startHand(cfg, stackedDeck(cfg, {}));
    s = play(s, ["p0", call], ["p1", call]);
    expect(s.street).toBe("preflop");
    expect(legalActions(s)).toMatchObject({ playerId: "p2", canCheck: true, canRaise: true });
    s = play(s, ["p2", check]);
    expect(s.street).toBe("flop");
    expect(s.board).toHaveLength(3);
    expect(legalActions(s)!.playerId).toBe("p1"); // first left of the button
  });

  it("collects antes as dead money", () => {
    const cfg = table([1000, 1000, 1000], { ante: 10 });
    let s = startHand(cfg, stackedDeck(cfg, {}));
    expect(stack(s, "p0")).toBe(990);
    expect(stack(s, "p2")).toBe(890);
    s = play(s, ["p0", fold], ["p1", fold]);
    expect(s.result!.payouts).toEqual({ p2: 180 }); // 3 antes + both blinds
    expect(stack(s, "p2")).toBe(1070); // 890 left after ante + blind, plus the 180 pot
  });
});

describe("betting rules", () => {
  it("enforces the minimum raise as the size of the last raise", () => {
    const cfg = table([5000, 5000, 5000]);
    let s = startHand(cfg, stackedDeck(cfg, {}));
    expect(legalActions(s)!.minRaiseTo).toBe(200);
    expect(() => applyAction(s, "p0", raise(150))).toThrow(/Minimum raise/);
    s = play(s, ["p0", raise(350)]); // raise of 250
    expect(legalActions(s)!.minRaiseTo).toBe(600);
  });

  it("rejects actions out of turn", () => {
    const cfg = table([1000, 1000, 1000]);
    const s = startHand(cfg, stackedDeck(cfg, {}));
    expect(() => applyAction(s, "p1", fold)).toThrow(/Not your turn/);
  });

  it("does not reopen raising after a short all-in", () => {
    // p0 raises to 300, p1 calls, p2 (BB) shoves 400 total: only 100 more, less than a full raise.
    const cfg = table([5000, 5000, 400]);
    let s = startHand(cfg, stackedDeck(cfg, {}));
    s = play(s, ["p0", raise(300)], ["p1", call], ["p2", raise(400)]);
    const l = legalActions(s)!;
    expect(l.playerId).toBe("p0");
    expect(l.canRaise).toBe(false);
    expect(l.callAmount).toBe(100);
  });

  it("allows an all-in for less than a minimum raise", () => {
    const cfg = table([1000, 1000, 150]);
    let s = startHand(cfg, stackedDeck(cfg, {}));
    s = play(s, ["p0", call], ["p1", call]);
    expect(legalActions(s)).toMatchObject({ playerId: "p2", minRaiseTo: 150, maxRaiseTo: 150 });
    s = play(s, ["p2", raise(150)]);
    expect(s.players[2]!.allIn).toBe(true);
  });

  it("returns an uncalled bet", () => {
    const cfg = table([1000, 1000, 1000]);
    let s = startHand(cfg, stackedDeck(cfg, {}));
    s = play(s, ["p0", raise(1000)], ["p1", fold], ["p2", fold]);
    expect(stack(s, "p0")).toBe(1150);
  });
});

describe("showdown and pots", () => {
  it("awards the pot to the best hand", () => {
    const cfg = table([1000, 1000]);
    let s = startHand(cfg, stackedDeck(cfg, { 0: "As Ad", 1: "Kc Kd" }));
    s = play(s, ["p0", call], ["p1", check]);
    for (let i = 0; i < 3; i++) s = play(s, ["p1", check], ["p0", check]);
    expect(s.street).toBe("complete");
    expect(s.result!.payouts).toEqual({ p0: 200 });
    expect(s.result!.showdown.map((x) => x.handName)).toEqual(["Pair", "Pair"]);
  });

  it("runs out the board when everyone is all-in", () => {
    const cfg = table([1000, 1000]);
    let s = startHand(cfg, stackedDeck(cfg, { 0: "As Ad", 1: "Kc Kd" }));
    s = play(s, ["p0", raise(1000)], ["p1", call]);
    expect(s.street).toBe("complete");
    expect(s.board).toHaveLength(5);
    expect(stack(s, "p0")).toBe(2000);
    expect(stack(s, "p1")).toBe(0);
  });

  it("builds side pots for multiple all-ins", () => {
    // p1 (short, 200) has the best hand, p2 (500) second, p0 (1000) worst.
    const cfg = table([1000, 200, 500]);
    let s = startHand(cfg, stackedDeck(cfg, { 0: "7c 2d", 1: "As Ad", 2: "Ks Kd" }, "4c 8d 9h Js 3s"));
    s = play(s, ["p0", raise(1000)], ["p1", call], ["p2", call]);
    expect(s.street).toBe("complete");
    const pots = s.result!.pots;
    expect(pots.map((p) => p.amount)).toEqual([600, 600, 500]);
    expect(pots[0]!.winners).toEqual([{ playerId: "p1", amount: 600 }]);
    expect(pots[1]!.winners).toEqual([{ playerId: "p2", amount: 600 }]);
    expect(pots[2]!.winners).toEqual([{ playerId: "p0", amount: 500 }]); // uncalled excess returned
    expect(stack(s, "p0")).toBe(500);
    expect(stack(s, "p1")).toBe(600);
    expect(stack(s, "p2")).toBe(600);
  });

  it("splits a tied pot and gives the odd chip left of the button", () => {
    // Board is a royal-ish straight both players share; antes make the pot odd.
    const cfg = table([1000, 1000, 1000], { ante: 1 });
    let s = startHand(cfg, stackedDeck(cfg, { 0: "2c 3d", 1: "4c 5d", 2: "6c 7d" }, "Ah Kd Qc Js Th"));
    s = play(s, ["p0", call], ["p1", call], ["p2", check]);
    for (let i = 0; i < 3; i++) s = play(s, ["p1", check], ["p2", check], ["p0", check]);
    // Pot = 3 antes + 300 = 303, split three ways = 101 each.
    expect(s.result!.payouts).toEqual({ p0: 101, p1: 101, p2: 101 });
  });

  it("gives the odd chip to the first winner left of the button", () => {
    const cfg = table([1000, 1000, 1000], { ante: 1 });
    let s = startHand(cfg, stackedDeck(cfg, { 0: "2c 3d", 1: "4c 5d", 2: "6c 6h" }, "Ah Kd Qc Js Th"));
    // p2 folds their big blind: pot = 3 antes + 3 x 100 = 303, split between p0 and p1.
    s = play(s, ["p0", call], ["p1", call], ["p2", fold]);
    for (let i = 0; i < 3; i++) s = play(s, ["p1", check], ["p0", check]);
    expect(s.result!.payouts).toEqual({ p1: 152, p0: 151 });
  });

  it("conserves chips", () => {
    const cfg = table([1000, 200, 500]);
    const before = 1700;
    let s = startHand(cfg, stackedDeck(cfg, { 0: "7c 2d", 1: "As Ad", 2: "Ks Kd" }));
    expect(total(s)).toBe(before);
    s = play(s, ["p0", raise(1000)], ["p1", call], ["p2", call]);
    expect(total(s)).toBe(before);
  });
});

describe("viewFor", () => {
  it("hides other players' cards and the deck", () => {
    const cfg = table([1000, 1000]);
    const s = startHand(cfg, stackedDeck(cfg, { 0: "As Ad", 1: "Kc Kd" }));
    const v = viewFor(s, "p0");
    expect(v.players[0]!.holeCards).toEqual(["As", "Ad"]);
    expect(v.players[1]!.holeCards).toEqual(["??", "??"]);
    expect("deck" in v).toBe(false);
    expect(v.legal?.playerId).toBe("p0");
    expect(viewFor(s, "p1").legal).toBeNull();
  });
});
