import { describe, expect, it } from "vitest";
import { type Action, legalActions } from "../src/shared/engine/hand.ts";
import { defaultConfig, payoutPercents } from "../src/server/tournament/structure.ts";
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

function makeTournament(players: number, cfg: Partial<TournamentConfig> = {}, hooks: Partial<TournamentHooks> = {}) {
  const t = Tournament.create(1, defaultConfig({ startTime: 0, ...cfg }), 0, { ...noopHooks, ...hooks }, seeded(42));
  for (let i = 1; i <= players; i++) t.register({ id: i, username: `bot${i}`, avatarUrl: "" }, 0);
  return t;
}

const counts = (t: Tournament) => [...t.tables.values()].map((tb) => tb.seats.filter(Boolean).length);

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

/** Plays a whole tournament with random bots. Returns the tournament after it finishes. */
function simulate(players: number, seed: number, cfg: Partial<TournamentConfig> = {}) {
  const t = makeTournament(players, { levels: defaultConfig().levels.map((l) => ({ ...l, minutes: 3 })), ...cfg });
  const rnd = seeded(seed);
  const total = players * t.config.startingStack;
  let now = 0;
  t.tick(now);
  expect(t.meta.status).toBe("running");
  for (let step = 0; step < 500_000 && t.meta.status === "running"; step++) {
    for (const tb of t.tables.values()) {
      const who = actor(tb);
      if (who !== null) t.act(who, randomAction(tb, rnd), now);
    }
    now += 500;
    t.tick(now);
    if (step % 50 === 0 && t.meta.status === "running") {
      expect(t.chipsInPlay()).toBe(total);
      expect(Math.max(...counts(t))).toBeLessThanOrEqual(t.config.tableSize);
      expect(t.tables.size).toBeLessThanOrEqual(Math.ceil(t.meta.remaining / t.config.tableSize) + 1);
    }
  }
  return t;
}

describe("seating", () => {
  it("starts automatically at the start time and seats players evenly", () => {
    const t = makeTournament(20, { startTime: 5 * MIN });
    t.tick(4 * MIN);
    expect(t.meta.status).toBe("registering");
    t.tick(5 * MIN);
    expect(t.meta.status).toBe("running");
    expect(counts(t).sort()).toEqual([6, 7, 7]);
    expect(t.meta.remaining).toBe(20);
  });

  it("does not start with fewer than two players", () => {
    const t = makeTournament(1);
    t.tick(10 * MIN);
    expect(t.meta.status).toBe("registering");
  });

  it("seats late registrants and closes registration after the late-reg levels", () => {
    const t = makeTournament(9, { lateRegLevels: 2, breakEveryLevels: 0 });
    t.tick(0);
    t.register({ id: 100, username: "late", avatarUrl: "" }, 1000);
    expect(t.meta.remaining).toBe(10);
    expect(t.meta.entrants[100]!.tableId).not.toBeNull();
    t.tick(2 * 10 * MIN + 1);
    expect(t.meta.clock.level).toBe(2);
    expect(() => t.register({ id: 101, username: "too late", avatarUrl: "" }, 2 * 10 * MIN + 2)).toThrow(/closed/);
  });

  it("only allows unregistering before the start", () => {
    const t = makeTournament(3);
    t.unregister(3);
    expect(t.entrantCount).toBe(2);
    t.tick(0);
    expect(() => t.unregister(1)).toThrow();
  });
});

describe("full tournaments with random bots", () => {
  for (const [players, seed] of [
    [2, 1],
    [10, 2],
    [47, 3],
    [200, 4],
  ] as const) {
    it(`${players} players play down to one winner with chips conserved`, () => {
      const t = simulate(players, seed);
      expect(t.meta.status).toBe("finished");
      const places = Object.values(t.meta.entrants).map((e) => e.place).sort((a, b) => a! - b!);
      expect(places).toEqual(Array.from({ length: players }, (_, i) => i + 1));
      expect(t.tables.size).toBe(0);
      const paid = payoutPercents(players, 15).length;
      for (const e of Object.values(t.meta.entrants)) expect(e.points > 0).toBe(e.place! <= paid);
    });
  }
});

describe("blind clock", () => {
  it("raises blinds and takes breaks with no hands dealt", () => {
    const levels = defaultConfig().levels.map((l) => ({ ...l, minutes: 10 }));
    const t = makeTournament(4, { levels, breakEveryLevels: 2, breakMinutes: 5 });
    t.tick(0);
    t.tick(10 * MIN);
    expect(t.meta.clock).toMatchObject({ phase: "level", level: 1 });
    t.tick(20 * MIN);
    expect(t.meta.clock).toMatchObject({ phase: "break", level: 1, endsAt: 25 * MIN });
    // Hands in progress may finish during the break, but no new ones start.
    const tb = [...t.tables.values()][0]!;
    for (let now = 20 * MIN; now < 24 * MIN; now += 1000) {
      const who = actor(tb);
      if (who !== null) t.act(who, { type: "fold" }, now);
      t.tick(now);
    }
    expect(tb.hand).toBeNull();
    t.tick(25 * MIN);
    expect(t.meta.clock).toMatchObject({ phase: "level", level: 2, endsAt: 35 * MIN });
    expect(tb.hand).not.toBeNull();
  });

  it("catches up correctly after a long gap between ticks", () => {
    const t = makeTournament(2, { breakEveryLevels: 0 });
    t.tick(0);
    t.tick(35 * MIN);
    expect(t.meta.clock).toMatchObject({ level: 3, endsAt: 40 * MIN });
  });
});

describe("decision timers", () => {
  it("uses the time bank, then auto-acts and marks the player away", () => {
    const t = makeTournament(2, { decisionSeconds: 20, timeBankSeconds: 60 });
    t.tick(0);
    const tb = [...t.tables.values()][0]!;
    const slow = actor(tb)!;
    t.tick(79_000);
    expect(actor(tb)).toBe(slow);
    t.tick(80_000);
    const seat = tb.seats.find((s) => s?.userId === slow)!;
    expect(seat.away).toBe(true);
    expect(seat.timeBankMs).toBe(0);
  });

  it("deducts only the overflow from the time bank", () => {
    const t = makeTournament(2, { decisionSeconds: 20, timeBankSeconds: 60 });
    t.tick(0);
    const tb = [...t.tables.values()][0]!;
    const who = actor(tb)!;
    t.act(who, { type: "call" }, 30_000);
    expect(tb.seats.find((s) => s?.userId === who)!.timeBankMs).toBe(50_000);
  });

  it("gives disconnected players the decision time only", () => {
    const t = makeTournament(2, { decisionSeconds: 20 }, { isConnected: () => false });
    t.tick(0);
    const tb = [...t.tables.values()][0]!;
    const who = actor(tb)!;
    t.tick(20_000);
    expect(tb.seats.find((s) => s?.userId === who)!.away).toBe(true);
  });

  it("acts instantly for away players until they come back", () => {
    const t = makeTournament(3);
    t.tick(0);
    const tb = [...t.tables.values()][0]!;
    const who = actor(tb)!;
    t.setAway(who, true);
    t.tick(1);
    expect(actor(tb)).not.toBe(who);
    t.setAway(who, false);
    expect(tb.seats.find((s) => s?.userId === who)!.away).toBe(false);
  });
});

describe("pause and crash recovery", () => {
  it("freezes and then shifts every timer on resume", () => {
    const t = makeTournament(2);
    t.tick(0);
    const tb = [...t.tables.values()][0]!;
    const startedAt = tb.actionStartedAt!;
    t.pause("dinner", 5_000);
    expect(() => t.act(actor(tb)!, { type: "fold" }, 6_000)).toThrow(/paused/);
    t.tick(10 * 60 * MIN); // nothing happens while paused
    expect(t.meta.clock.level).toBe(0);
    t.resume(60 * MIN);
    expect(tb.actionStartedAt).toBe(startedAt + 60 * MIN - 5_000);
    expect(t.meta.clock.endsAt).toBe(10 * MIN + 60 * MIN - 5_000);
  });

  it("restores from saved JSON paused at the last save, mid-hand", () => {
    const t = makeTournament(12);
    t.tick(0);
    const tb = [...t.tables.values()][0]!;
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
    expect(restored.chipsInPlay()).toBe(t.chipsInPlay());
  });
});

describe("busts and admin", () => {
  it("removes a kicked player at the end of the hand", () => {
    const t = makeTournament(3);
    t.tick(0);
    const tb = [...t.tables.values()][0]!;
    const victim = actor(tb)!;
    t.kick(victim);
    t.tick(1);
    expect(t.meta.entrants[victim]!.place).toBeNull();
    for (let now = 2; now < 60_000 && t.meta.entrants[victim]!.place === null; now += 500) {
      const who = actor(tb);
      if (who !== null) t.act(who, { type: "fold" }, now);
      t.tick(now);
    }
    expect(t.meta.entrants[victim]!.place).toBe(3);
    expect(t.meta.remaining).toBe(2);
  });

  it("breaks tables down to a single final table", () => {
    const t = simulate(30, 9, { payoutPercent: 30 });
    expect(t.meta.status).toBe("finished");
  });
});
