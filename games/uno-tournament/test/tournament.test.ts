import { describe, expect, it } from "vitest";
import { nextRandom } from "../src/shared/engine/cards.ts";
import { autoAction, current } from "../src/shared/engine/game.ts";
import type { ClientAction } from "../src/shared/protocol.ts";
import { defaultConfig } from "../src/server/tournament/structure.ts";
import { HAND_DONE_MS, Tournament, TournamentError, noopHooks } from "../src/server/tournament/tournament.ts";
import type { TableState, TournamentConfig } from "../src/server/tournament/types.ts";

const T0 = 1_000_000;

function seeded(seed: number) {
  const s = { rng: seed };
  return () => nextRandom(s);
}

function make(players: number, cfg: Partial<TournamentConfig> = {}, seed = 1, hooks = noopHooks) {
  const config: TournamentConfig = { ...defaultConfig(), startTime: T0, maxPlayers: 1000, ...cfg };
  const t = Tournament.create(1, config, T0, hooks, seeded(seed));
  for (let i = 1; i <= players; i++) t.register({ id: i, username: `P${i}`, avatarUrl: "" }, T0);
  return t;
}

/** Every seated player whose turn it is plays a sensible move; then time moves on. Returns the final time. */
function playOut(t: Tournament, now = T0, maxSteps = 200_000) {
  for (let step = 0; step < maxSteps && t.meta.status !== "finished"; step++) {
    for (const table of t.tables.values()) {
      const g = table.game;
      if (g && !g.winner) t.act(Number(current(g).playerId), autoAction(g) as ClientAction, now);
    }
    now += 1000;
    t.tick(now);
  }
  return now;
}

function expectPlacesComplete(t: Tournament) {
  const places = Object.values(t.meta.entrants).map((e) => e.place);
  expect(places.every((p) => p !== null)).toBe(true);
  expect(new Set(places).size).toBe(places.length);
  expect(Math.min(...(places as number[]))).toBe(1);
  expect(Math.max(...(places as number[]))).toBe(places.length);
}

describe("bracket", () => {
  it("seats round 1 at balanced tables no bigger than the table size", () => {
    for (const [n, size] of [[2, 4], [5, 4], [9, 4], [23, 6], [100, 3], [7, 5]] as const) {
      const t = make(n, { tableSize: size });
      t.start(T0);
      const sizes = [...t.tables.values()].map((tb) => tb.seats.filter(Boolean).length);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(n);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(size);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(2);
    }
  });

  it("starts by itself at the start time with two or more players, not before", () => {
    const t = make(2);
    t.tick(T0 - 1);
    expect(t.meta.status).toBe("registering");
    t.tick(T0);
    expect(t.meta.status).toBe("running");
    const lonely = make(1);
    lonely.tick(T0 + 1);
    expect(lonely.meta.status).toBe("registering");
    expect(() => lonely.start(T0)).toThrow(TournamentError);
  });

  for (const [n, size, wins, stacking] of [
    [2, 4, 1, false],
    [7, 4, 2, true],
    [50, 4, 2, false],
    [300, 6, 1, true],
    [37, 3, 3, false],
  ] as const) {
    it(`plays a full tournament: ${n} players, ${size} per table, first to ${wins}${stacking ? ", stacking" : ""}`, () => {
      const finished: number[] = [];
      let done = 0;
      const t = make(n, { tableSize: size, winsToAdvance: wins, stacking }, n, {
        ...noopHooks,
        playerFinished: (userId) => finished.push(userId),
        tournamentFinished: () => done++,
      });
      t.start(T0);
      playOut(t);
      expect(t.meta.status).toBe("finished");
      expect(done).toBe(1);
      expect(t.tables.size).toBe(0);
      expect(t.meta.remaining).toBe(0);
      expectPlacesComplete(t);
      expect(new Set(finished).size).toBe(n);
      // The champion won every round's table.
      const champ = Object.values(t.meta.entrants).find((e) => e.place === 1)!;
      expect(champ.round).toBe(t.meta.totalRounds);
      // Later rounds always finish ahead of earlier ones.
      const all = Object.values(t.meta.entrants);
      for (const a of all) for (const b of all) if (a.round > b.round) expect(a.place!).toBeLessThan(b.place!);
    });
  }

  it("a table needs the set number of hand wins", () => {
    const t = make(3, { winsToAdvance: 2 });
    t.start(T0);
    const table = [...t.tables.values()][0]!;
    let now = T0;
    // Play exactly one hand.
    while (!table.game?.winner) {
      t.tick(now);
      const g = table.game;
      if (g && !g.winner) t.act(Number(current(g).playerId), autoAction(g) as ClientAction, now);
    }
    now += HAND_DONE_MS + 1;
    t.tick(now);
    expect(t.tables.has(table.id)).toBe(true);
    expect(table.seats.filter(Boolean).map((s) => s!.wins).sort()).toEqual([0, 0, 1]);
    expect(table.handNo).toBe(2);
  });
});

describe("timers, pausing and restarts", () => {
  it("plays automatically for someone who runs out of time, without waiting next time", () => {
    const t = make(2, { decisionSeconds: 10, timeBankSeconds: 5 });
    t.start(T0);
    t.tick(T0);
    const table = [...t.tables.values()][0]!;
    const first = current(table.game!).playerId;
    t.tick(T0 + 14_000);
    expect(current(table.game!).playerId).toBe(first);
    t.tick(T0 + 15_001);
    const seat = table.seats.find((s) => s?.userId === Number(first))!;
    expect(seat.away).toBe(true);
    expect(seat.timeBankMs).toBe(0);
  });

  it("pausing freezes the clock, resuming continues it", () => {
    const t = make(2, { decisionSeconds: 10, timeBankSeconds: 0 });
    t.start(T0);
    t.tick(T0);
    const table = [...t.tables.values()][0]!;
    const toAct = current(table.game!).playerId;
    t.pause("test", T0 + 5000);
    t.tick(T0 + 60_000);
    expect(() => t.act(Number(toAct), { type: "draw" }, T0 + 60_000)).toThrow("paused");
    t.resume(T0 + 60_000);
    t.tick(T0 + 64_000); // 5 s used before the pause + 4 s now: still their turn
    expect(current(table.game!).playerId).toBe(toAct);
    expect(table.seats.find((s) => s?.userId === Number(toAct))!.away).toBe(false);
  });

  it("comes back paused mid-hand after a restart and plays on to the end", () => {
    const t = make(9, { tableSize: 3, winsToAdvance: 1 }, 5);
    t.start(T0);
    let now = T0;
    for (let i = 0; i < 40; i++) {
      for (const table of t.tables.values()) {
        const g = table.game;
        if (g && !g.winner) t.act(Number(current(g).playerId), autoAction(g) as ClientAction, now);
      }
      now += 300;
      t.tick(now);
    }
    t.meta.savedAt = now;
    const saved = JSON.parse(JSON.stringify({ meta: t.meta, tables: [...t.tables.values()] })) as { meta: Tournament["meta"]; tables: TableState[] };
    const restored = new Tournament(saved.meta, new Map(saved.tables.map((tb) => [tb.id, tb])), noopHooks, seeded(9));
    restored.restoreAfterRestart();
    expect(restored.meta.paused).toBe(true);
    expect([...restored.tables.values()].map((tb) => tb.game?.players.map((p) => p.hand))).toEqual([...t.tables.values()].map((tb) => tb.game?.players.map((p) => p.hand)));
    restored.resume(now + 10_000);
    playOut(restored, now + 10_000);
    expect(restored.meta.status).toBe("finished");
    expectPlacesComplete(restored);
  });
});

describe("players", () => {
  it("only lets the player whose turn it is act, but anyone at the table can catch", () => {
    const t = make(3);
    t.start(T0);
    t.tick(T0);
    const table = [...t.tables.values()][0]!;
    const g = table.game!;
    const notMe = g.players.find((p) => p.playerId !== current(g).playerId)!;
    expect(() => t.act(Number(notMe.playerId), { type: "draw" }, T0)).toThrow("not your turn");
    expect(() => t.act(99, { type: "draw" }, T0)).toThrow("not seated");
    expect(() => t.act(Number(notMe.playerId), { type: "catch", seat: current(g).seat }, T0)).toThrow("Too late");
  });

  it("removing a player knocks them out and the table carries on", () => {
    const t = make(3, { winsToAdvance: 1 });
    t.start(T0);
    t.tick(T0);
    const table = [...t.tables.values()][0]!;
    const victim = Number(current(table.game!).playerId);
    t.kick(victim, T0);
    expect(t.meta.entrants[victim]!.place).toBe(3);
    expect(table.game!.players).toHaveLength(2);
    playOut(t, T0);
    expect(t.meta.status).toBe("finished");
    expectPlacesComplete(t);
  });

  it("removing all but one player ends the table", () => {
    const t = make(2);
    t.start(T0);
    t.tick(T0);
    t.kick(1, T0);
    t.tick(T0 + HAND_DONE_MS + 1);
    expect(t.meta.status).toBe("finished");
    expect(t.meta.entrants[2]!.place).toBe(1);
    expect(t.meta.entrants[1]!.place).toBe(2);
  });

  it("cancelling closes every table", () => {
    const t = make(10);
    t.start(T0);
    t.cancel(T0 + 1);
    expect(t.meta.status).toBe("cancelled");
    expect(t.tables.size).toBe(0);
    expect(() => t.cancel(T0 + 2)).toThrow();
  });
});
