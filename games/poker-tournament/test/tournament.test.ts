import { describe, expect, it } from "vitest";
import { type Action, legalActions } from "../src/shared/engine/hand.ts";
import { bracketShape, defaultConfig, payoutPercents, payoutPoints } from "../src/server/tournament/structure.ts";
import { Tournament, type TournamentHooks, noopHooks } from "../src/server/tournament/tournament.ts";
import type { TableState, TournamentConfig } from "../src/server/tournament/types.ts";

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN = 60_000;
const STACK = 10_000;

function makeTournament(players: number, cfg: Partial<TournamentConfig> = {}, hooks: Partial<TournamentHooks> = {}) {
  const t = Tournament.create(1, defaultConfig({ startTime: 0, ...cfg }), 0, { ...noopHooks, ...hooks }, seeded(42));
  for (let i = 1; i <= players; i++) t.register({ id: i, username: `bot${i}`, avatarUrl: "" }, 0);
  return t;
}

const tablesOf = (t: Tournament) => [...t.tables.values()];
const sizes = (t: Tournament) => tablesOf(t).map((tb) => tb.seats.filter(Boolean).length);
const firstTable = (t: Tournament) => tablesOf(t)[0]!;
const seatOf = (tb: TableState, userId: number) => tb.seats.find((s) => s?.userId === userId)!;

/** The user whose turn it is at a table, if any. */
function actor(tb: TableState): number | null {
  const h = tb.hand;
  if (!h || h.toAct === null) return null;
  return Number(h.players[h.toAct]!.playerId);
}

function randomAction(tb: TableState, rnd: () => number): Action {
  const l = legalActions(tb.hand!)!;
  const r = rnd();
  if (l.canRaise && r < 0.15) {
    const to = rnd() < 0.3 ? l.maxRaiseTo : Math.min(l.maxRaiseTo, l.minRaiseTo + Math.floor(rnd() * l.minRaiseTo));
    return { type: "raise", to };
  }
  if (!l.canCheck && r < 0.35) return { type: "fold" };
  return l.canCheck ? { type: "check" } : { type: "call" };
}

/**
 * Plays a whole tournament with random bots, checking on every step that each table keeps exactly
 * the chips it started with and that every new table starts everyone on an equal stack.
 */
function simulate(players: number, seed: number, cfg: Partial<TournamentConfig> = {}) {
  const t = makeTournament(players, { levels: defaultConfig().levels.map((l) => ({ ...l, minutes: 3 })), ...cfg });
  const rnd = seeded(seed);
  const startChips = new Map<number, number>();
  /** For each later-round table: how many earlier-round tables were still playing when it opened. */
  const openedWhileEarlierRoundsPlayed: number[] = [];
  const check = () => {
    for (const tb of t.tables.values()) {
      if (!startChips.has(tb.id)) {
        // A brand-new table: everyone starts level, fresh blinds.
        expect(tb.seats.filter(Boolean).every((s) => s!.chips === STACK)).toBe(true);
        expect(tb.clock.level).toBe(0);
        startChips.set(tb.id, tb.seats.filter(Boolean).length * STACK);
        if (tb.round > 1) openedWhileEarlierRoundsPlayed.push(tablesOf(t).filter((o) => o.round < tb.round).length);
      }
      expect(t.chipsAt(tb)).toBe(startChips.get(tb.id));
      expect(tb.seats.filter(Boolean).length).toBeLessThanOrEqual(6);
    }
  };
  let now = 0;
  t.tick(now);
  expect(t.meta.status).toBe("running");
  check();
  for (let step = 0; step < 500_000 && t.meta.status === "running"; step++) {
    for (const tb of t.tables.values()) {
      const who = actor(tb);
      if (who !== null) t.act(who, randomAction(tb, rnd), now);
    }
    now += 500;
    t.tick(now);
    check();
  }
  return { t, openedWhileEarlierRoundsPlayed };
}

describe("bracket", () => {
  it("collapses six tables into one each round", () => {
    expect(bracketShape(2)).toEqual([1]);
    expect(bracketShape(6)).toEqual([1]);
    expect(bracketShape(7)).toEqual([2, 1]);
    expect(bracketShape(36)).toEqual([6, 1]);
    expect(bracketShape(40)).toEqual([7, 2, 1]);
    expect(bracketShape(200)).toEqual([34, 6, 1]);
    expect(bracketShape(216)).toEqual([36, 6, 1]);
    expect(bracketShape(1296)).toEqual([216, 36, 6, 1]);
  });

  it("seats a full field six to a table with a full bracket above it", () => {
    const t = makeTournament(216);
    t.tick(0);
    expect(sizes(t)).toEqual(Array(36).fill(6));
    expect(t.meta.totalRounds).toBe(3);
    const round2 = t.meta.bracket.filter((n) => n.round === 2);
    expect(round2).toHaveLength(6);
    expect(round2.every((n) => n.children.length === 6)).toBe(true);
    expect(t.meta.bracket.filter((n) => n.round === 3)[0]!.children).toHaveLength(6);
    expect(tablesOf(t).every((tb) => t.chipsAt(tb) === 6 * STACK)).toBe(true);
  });

  it("spreads a partial field evenly", () => {
    const t = makeTournament(40);
    t.tick(0);
    expect(sizes(t).sort()).toEqual([5, 5, 6, 6, 6, 6, 6]);
    expect(t.meta.bracket.filter((n) => n.round === 2).map((n) => n.children.length)).toEqual([4, 3]);
  });

  it("starts automatically at the start time, but not with one player", () => {
    const t = makeTournament(12, { startTime: 5 * MIN });
    t.tick(4 * MIN);
    expect(t.meta.status).toBe("registering");
    t.tick(5 * MIN);
    expect(t.meta.status).toBe("running");
    const solo = makeTournament(1);
    solo.tick(10 * MIN);
    expect(solo.meta.status).toBe("registering");
  });

  it("closes registration at the start and allows unregistering only before", () => {
    const t = makeTournament(3);
    t.unregister(3);
    expect(t.entrantCount).toBe(2);
    t.tick(0);
    expect(() => t.unregister(1)).toThrow();
    expect(() => t.register({ id: 99, username: "late", avatarUrl: "" }, 1)).toThrow(/closed/);
  });

  it("respects the player cap", () => {
    const t = makeTournament(6, { maxPlayers: 6 });
    expect(() => t.register({ id: 7, username: "x", avatarUrl: "" }, 0)).toThrow(/full/);
  });
});

describe("payouts", () => {
  it("hands out exactly 100 points per entrant", () => {
    for (const n of [2, 9, 26, 137, 1296]) {
      const pts = payoutPoints(n, 15);
      expect(pts.reduce((a, b) => a + b, 0)).toBe(n * 100);
      for (let i = 1; i < pts.length; i++) expect(pts[i]!).toBeLessThanOrEqual(pts[i - 1]!);
    }
  });
});

describe("full shootouts with random bots", () => {
  for (const [players, seed] of [
    [2, 1],
    [6, 2],
    [7, 3],
    [40, 4],
    [216, 5],
  ] as const) {
    it(`${players} players play down to one winner, every table fair from its first hand`, () => {
      const { t } = simulate(players, seed);
      expect(t.meta.status).toBe("finished");
      expect(t.tables.size).toBe(0);
      const entrants = Object.values(t.meta.entrants);
      expect(entrants.map((e) => e.place).sort((a, b) => a! - b!)).toEqual(Array.from({ length: players }, (_, i) => i + 1));

      // Going out in a later round always beats going out in an earlier one.
      for (const a of entrants)
        for (const b of entrants) if (a.round > b.round) expect(a.place!).toBeLessThan(b.place!);

      const paid = payoutPercents(players, 15).length;
      for (const e of entrants) expect(e.points > 0).toBe(e.place! <= paid);
    });
  }

  it("starts a group's next table without waiting for the whole round", () => {
    const { openedWhileEarlierRoundsPlayed } = simulate(216, 6);
    expect(Math.max(...openedWhileEarlierRoundsPlayed)).toBeGreaterThan(0);
  });
});

describe("per-table blind clock", () => {
  it("runs from level 1 at each table, with breaks", () => {
    const levels = defaultConfig().levels.map((l) => ({ ...l, minutes: 10 }));
    const t = makeTournament(6, { levels, breakEveryLevels: 2, breakMinutes: 5 });
    t.tick(0);
    const tb = firstTable(t);
    t.tick(10 * MIN);
    expect(tb.clock).toMatchObject({ phase: "level", level: 1 });
    t.tick(20 * MIN);
    expect(tb.clock).toMatchObject({ phase: "break", level: 1, endsAt: 25 * MIN });
    // A hand in progress may finish during the break, but no new one starts.
    for (let now = 20 * MIN; now < 24 * MIN; now += 1000) {
      const who = actor(tb);
      if (who !== null) t.act(who, { type: "fold" }, now);
      t.tick(now);
    }
    expect(tb.hand).toBeNull();
    t.tick(25 * MIN);
    expect(tb.clock).toMatchObject({ phase: "level", level: 2, endsAt: 35 * MIN });
    expect(tb.hand).not.toBeNull();
  });

  it("catches up correctly after a long gap between ticks", () => {
    const t = makeTournament(2, { breakEveryLevels: 0 });
    t.tick(0);
    t.tick(35 * MIN);
    expect(firstTable(t).clock).toMatchObject({ level: 3, endsAt: 40 * MIN });
  });
});

describe("decision timers", () => {
  it("uses the time bank, then auto-acts and marks the player away", () => {
    const t = makeTournament(2, { decisionSeconds: 20, timeBankSeconds: 60 });
    t.tick(0);
    const tb = firstTable(t);
    const slow = actor(tb)!;
    t.tick(79_000);
    expect(actor(tb)).toBe(slow);
    t.tick(80_000);
    expect(seatOf(tb, slow).away).toBe(true);
    expect(seatOf(tb, slow).timeBankMs).toBe(0);
  });

  it("deducts only the overflow from the time bank", () => {
    const t = makeTournament(2, { decisionSeconds: 20, timeBankSeconds: 60 });
    t.tick(0);
    const tb = firstTable(t);
    const who = actor(tb)!;
    t.act(who, { type: "call" }, 30_000);
    expect(seatOf(tb, who).timeBankMs).toBe(50_000);
  });

  it("gives disconnected players the decision time only", () => {
    const t = makeTournament(2, { decisionSeconds: 20 }, { isConnected: () => false });
    t.tick(0);
    const tb = firstTable(t);
    const who = actor(tb)!;
    t.tick(20_000);
    expect(seatOf(tb, who).away).toBe(true);
  });

  it("acts instantly for away players until they come back", () => {
    const t = makeTournament(3);
    t.tick(0);
    const tb = firstTable(t);
    const who = actor(tb)!;
    t.setAway(who, true);
    t.tick(1);
    expect(actor(tb)).not.toBe(who);
    t.setAway(who, false);
    expect(seatOf(tb, who).away).toBe(false);
  });
});

describe("pause and crash recovery", () => {
  it("freezes and then shifts every timer on resume", () => {
    const t = makeTournament(2);
    t.tick(0);
    const tb = firstTable(t);
    const startedAt = tb.actionStartedAt!;
    t.pause("dinner", 5_000);
    expect(() => t.act(actor(tb)!, { type: "fold" }, 6_000)).toThrow(/paused/);
    t.tick(10 * 60 * MIN); // nothing happens while paused
    expect(tb.clock.level).toBe(0);
    t.resume(60 * MIN);
    expect(tb.actionStartedAt).toBe(startedAt + 60 * MIN - 5_000);
    expect(tb.clock.endsAt).toBe(10 * MIN + 60 * MIN - 5_000);
  });

  it("restores from saved JSON paused at the last save, mid-hand", () => {
    const t = makeTournament(12);
    t.tick(0);
    const tb = firstTable(t);
    t.act(actor(tb)!, { type: "call" }, 2000);
    t.meta.savedAt = 3000;

    const meta = JSON.parse(JSON.stringify(t.meta));
    const tables = new Map([...t.tables].map(([id, x]) => [id, JSON.parse(JSON.stringify(x))]));
    const restored = new Tournament(meta, tables);
    restored.restoreAfterRestart();
    expect(restored.meta.paused).toBe(true);
    expect(restored.meta.pausedAt).toBe(3000);
    restored.resume(100_000);
    const rtb = restored.tables.get(tb.id)!;
    expect(rtb.hand!.log).toEqual(tb.hand!.log);
    expect(rtb.actionStartedAt).toBe(2000 + 97_000);
    expect(restored.chipsAt(rtb)).toBe(t.chipsAt(tb));
  });
});

describe("advancing and admin", () => {
  it("moves a table winner up the bracket and tells them", () => {
    const advanced: [number, number][] = [];
    const t = makeTournament(12, {}, { playerAdvanced: (u, r) => advanced.push([u, r]) });
    t.tick(0);
    const [a, b] = tablesOf(t);
    // Remove everyone but one player at table A.
    const keep = a!.seats.find(Boolean)!.userId;
    for (const s of a!.seats) if (s && s.userId !== keep) t.kick(s.userId, 1);
    for (let now = 2; now < 60_000 && t.tables.has(a!.id); now += 500) {
      const who = actor(a!);
      if (who !== null && !seatOf(a!, who).leaving) t.act(who, { type: "fold" }, now);
      t.tick(now);
    }
    expect(t.tables.has(a!.id)).toBe(false);
    expect(advanced).toEqual([[keep, 2]]);
    const e = t.meta.entrants[keep]!;
    expect(e.tableId).toBeNull();
    expect(e.advancedTo).not.toBeNull();
    expect(t.summary(keep).me!.waiting).toMatchObject({ round: 2, groupDone: 1, groupSize: 2 });
    expect(t.tables.has(b!.id)).toBe(true);
  });

  it("removes a kicked player at the end of the hand", () => {
    const t = makeTournament(3);
    t.tick(0);
    const tb = firstTable(t);
    const victim = actor(tb)!;
    t.kick(victim, 0);
    t.tick(1);
    expect(t.meta.entrants[victim]!.place).toBeNull();
    for (let now = 2; now < 60_000 && t.meta.entrants[victim]!.place === null; now += 500) {
      const who = actor(tb);
      if (who !== null && !seatOf(tb, who).leaving) t.act(who, { type: "fold" }, now);
      t.tick(now);
    }
    expect(t.meta.entrants[victim]!.place).toBe(3);
    expect(t.meta.remaining).toBe(2);
  });
});

describe("chips between rounds", () => {
  /** Plays a whole tournament; for every table that opens, records each player's stack and the table's total. */
  function playOut(players: number, cfg: Partial<TournamentConfig>, seed: number) {
    const t = makeTournament(players, { levels: defaultConfig().levels.map((l) => ({ ...l, minutes: 3 })), ...cfg });
    const rnd = seeded(seed);
    const opened = new Map<number, { round: number; stacks: number[]; total: number }>();
    const record = () => {
      for (const tb of t.tables.values()) {
        if (opened.has(tb.id)) continue;
        const stacks = tb.seats.filter(Boolean).map((s) => s!.chips);
        opened.set(tb.id, { round: tb.round, stacks, total: stacks.reduce((a, b) => a + b, 0) });
      }
    };
    let now = 0;
    t.tick(now);
    record();
    for (let step = 0; step < 500_000 && t.meta.status === "running"; step++) {
      for (const tb of t.tables.values()) {
        const who = actor(tb);
        if (who !== null) t.act(who, randomAction(tb, rnd), now);
      }
      now += 500;
      t.tick(now);
      record();
    }
    expect(t.meta.status).toBe("finished");
    return { t, opened };
  }

  it("Fair Play: every table, in every round, starts everyone on the starting stack", () => {
    const { t, opened } = playOut(36, { chipMode: "fair" }, 11);
    expect(t.config.chipMode).toBe("fair");
    const later = [...opened.values()].filter((o) => o.round > 1);
    expect(later.length).toBeGreaterThan(0);
    for (const o of opened.values()) expect(o.stacks.every((s) => s === STACK)).toBe(true);
  });

  it("Full-on Bullying: table winners bring every chip they won to the next table", () => {
    // 40 players: round-1 tables of 6 and 5, so winners arrive with different stacks.
    const { t, opened } = playOut(40, { chipMode: "bully" }, 12);
    const firstRound = [...opened.values()].filter((o) => o.round === 1);
    expect(firstRound.every((o) => o.stacks.every((s) => s === STACK))).toBe(true);

    for (const node of t.meta.bracket.filter((n) => n.round > 1 && opened.has(n.id))) {
      const o = opened.get(node.id)!;
      // Each child table's whole total comes up with its winner…
      const childTotals = node.children.map((c) => opened.get(c)?.total ?? 0).filter((x) => x > 0);
      expect(o.stacks.slice().sort((a, b) => a - b)).toEqual(childTotals.slice().sort((a, b) => a - b));
      // …so nobody at a later table is on the plain starting stack.
      expect(o.stacks.every((s) => s > STACK)).toBe(true);
    }
    // Every chip in the tournament ends up at the final table.
    const final = [...opened.values()].find((o) => o.round === t.meta.totalRounds)!;
    expect(final.total).toBe(40 * STACK);
  });

  it("treats tournaments saved before the setting existed as Fair Play", () => {
    const t = makeTournament(6);
    delete t.meta.config.chipMode;
    t.tick(0);
    expect(firstTable(t).seats.filter(Boolean).every((s) => s!.chips === STACK)).toBe(true);
    expect(t.summary(null).chipMode).toBe("fair");
  });
});
