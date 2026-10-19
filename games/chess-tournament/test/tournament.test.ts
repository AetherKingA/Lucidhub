import { describe, expect, it } from "vitest";
import { legalUci, seededRandom } from "../src/shared/engine/chess.ts";
import { FIRST_MOVE_MS, bracketShape, defaultConfig } from "../src/server/tournament/structure.ts";
import { GAME_DONE_MS, Tournament, TournamentError, noopHooks } from "../src/server/tournament/tournament.ts";
import type { TableState, TournamentConfig } from "../src/server/tournament/types.ts";

const T0 = 1_000_000;

function make(players: number, cfg: Partial<TournamentConfig> = {}, seed = 1, hooks = noopHooks) {
  const config: TournamentConfig = { ...defaultConfig(), startTime: T0, maxPlayers: 1024, ...cfg };
  const t = Tournament.create(1, config, T0, hooks, seededRandom(seed));
  for (let i = 1; i <= players; i++) t.register({ id: i, username: `P${i}`, avatarUrl: "" }, T0);
  return t;
}

const toMove = (table: TableState) => {
  const g = table.game!;
  return g.chess.turn === "w" ? g.white : g.black;
};

/** Everyone to move plays a random legal move each second (resigning now and then so games end). */
function playOut(t: Tournament, now = T0, rng = seededRandom(7), maxSteps = 500_000) {
  for (let step = 0; step < maxSteps && t.meta.status !== "finished"; step++) {
    for (const table of t.tables.values()) {
      const g = table.game;
      if (!g || g.result) continue;
      if (rng() < 0.01) t.act(toMove(table), { type: "resign" }, now);
      else {
        const moves = legalUci(g.chess);
        t.act(toMove(table), { type: "move", uci: moves[Math.floor(rng() * moves.length)]! }, now);
      }
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

/** Starts a 2-player tournament and returns its only board. */
function oneBoard(cfg: Partial<TournamentConfig> = {}) {
  const t = make(2, cfg);
  t.start(T0);
  t.tick(T0);
  return { t, table: [...t.tables.values()][0]! };
}

describe("bracket", () => {
  it("sizes the bracket to the next power of two", () => {
    expect(bracketShape(2)).toEqual([1]);
    expect(bracketShape(5)).toEqual([4, 2, 1]);
    expect(bracketShape(8)).toEqual([4, 2, 1]);
    expect(bracketShape(9)).toEqual([8, 4, 2, 1]);
  });

  it("pairs everyone in round 1 and gives the rest byes, spread out", () => {
    for (const n of [2, 3, 5, 6, 7, 8, 11, 33, 100]) {
      const advanced: number[] = [];
      const t = make(n, {}, n, { ...noopHooks, playerAdvanced: (userId, _round, bye) => bye && advanced.push(userId) });
      t.start(T0);
      const slots = bracketShape(n)[0]! * 2;
      const byes = slots - n;
      const seated = [...t.tables.values()].filter((tb) => tb.round === 1).flatMap((tb) => tb.seats.filter(Boolean));
      expect(seated.length).toBe(2 * (n - slots / 2));
      expect(advanced.length).toBe(byes);
      // No round-2 match is between two players who both had byes unless there are more byes than matches.
      const round2 = t.meta.bracket.filter((b) => b.round === 2);
      if (byes <= round2.length) for (const node of round2) expect(t.tables.has(node.id)).toBe(false);
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

  for (const [n, wins] of [
    [2, 1],
    [3, 2],
    [8, 1],
    [13, 2],
    [64, 1],
    [21, 3],
  ] as const) {
    it(`plays a full tournament: ${n} players, first to ${wins}`, () => {
      const finished: number[] = [];
      let done = 0;
      const t = make(n, { winsToAdvance: wins }, n, {
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
      const champ = Object.values(t.meta.entrants).find((e) => e.place === 1)!;
      expect(champ.round).toBe(t.meta.totalRounds);
      // Later rounds always finish ahead of earlier ones.
      const all = Object.values(t.meta.entrants);
      for (const a of all) for (const b of all) if (a.round > b.round) expect(a.place!).toBeLessThan(b.place!);
    });
  }
});

describe("matches", () => {
  it("alternates colors and needs the set number of wins", () => {
    const { t, table } = oneBoard({ winsToAdvance: 2 });
    const firstWhite = table.game!.white;
    t.act(firstWhite, { type: "resign" }, T0);
    t.tick(T0 + GAME_DONE_MS);
    expect(t.tables.has(table.id)).toBe(true);
    expect(table.seats.map((s) => s!.wins).sort()).toEqual([0, 1]);
    expect(table.gameNo).toBe(2);
    expect(table.game!.white).not.toBe(firstWhite);
  });

  it("checkmate wins the game", () => {
    const { t, table } = oneBoard();
    const g = table.game!;
    for (const uci of ["f2f3", "e7e5", "g2g4", "d8h4"]) t.act(toMove(table), { type: "move", uci }, T0 + 1000);
    expect(g.result).toEqual({ winner: g.black, reason: "checkmate" });
    t.tick(T0 + 1000 + GAME_DONE_MS);
    expect(t.meta.status).toBe("finished");
    expect(t.meta.entrants[g.black]!.place).toBe(1);
  });

  it("draws don't count, and after two in a row Armageddon decides", () => {
    const { t, table } = oneBoard();
    let now = T0;
    for (let i = 0; i < 2; i++) {
      const g = table.game!;
      expect(g.armageddon).toBe(false);
      t.act(g.white, { type: "draw" }, now);
      expect(() => t.act(g.white, { type: "draw" }, now)).toThrow("already offered");
      t.act(g.black, { type: "draw" }, now);
      expect(g.result).toEqual({ winner: null, reason: "agreement" });
      now += GAME_DONE_MS;
      t.tick(now);
    }
    expect(table.seats.map((s) => [s!.wins, s!.draws])).toEqual([[0, 2], [0, 2]]);
    const g = table.game!;
    expect(g.armageddon).toBe(true);
    t.act(g.black, { type: "draw" }, now);
    t.act(g.white, { type: "draw" }, now);
    expect(g.result?.winner).toBe(g.black);
    t.tick(now + GAME_DONE_MS);
    expect(t.meta.entrants[g.black]!.place).toBe(1);
  });

  it("moving declines a draw offer; so does declining", () => {
    const { t, table } = oneBoard();
    const g = table.game!;
    t.act(g.black, { type: "draw" }, T0);
    t.act(g.white, { type: "move", uci: "e2e4" }, T0);
    expect(g.drawOffer).toBeNull();
    t.act(g.white, { type: "draw" }, T0);
    t.act(g.black, { type: "declineDraw" }, T0);
    expect(g.drawOffer).toBeNull();
    expect(() => t.act(g.black, { type: "declineDraw" }, T0)).toThrow("no draw offer");
  });

  it("only the player to move can move, and only legal moves", () => {
    const { t, table } = oneBoard();
    const g = table.game!;
    expect(() => t.act(g.black, { type: "move", uci: "e7e5" }, T0)).toThrow("not your turn");
    expect(() => t.act(g.white, { type: "move", uci: "e2e5" }, T0)).toThrow("isn't legal");
    expect(() => t.act(99, { type: "move", uci: "e2e4" }, T0)).toThrow("not seated");
  });
});

describe("clocks, pausing and restarts", () => {
  it("losing your first move window loses the game", () => {
    const { t, table } = oneBoard();
    const g = table.game!;
    t.tick(T0 + FIRST_MOVE_MS - 1);
    expect(g.result).toBeNull();
    t.tick(T0 + FIRST_MOVE_MS);
    expect(g.result).toEqual({ winner: g.black, reason: "no-move" });
  });

  it("runs the clock from the second move and adds the increment", () => {
    const { t, table } = oneBoard({ minutes: 1, incrementSeconds: 2 });
    const g = table.game!;
    t.act(g.white, { type: "move", uci: "e2e4" }, T0 + 20_000);
    t.act(g.black, { type: "move", uci: "e7e5" }, T0 + 40_000);
    expect(g.clocks).toEqual({ w: 60_000, b: 60_000 });
    t.act(g.white, { type: "move", uci: "g1f3" }, T0 + 50_000);
    expect(g.clocks.w).toBe(52_000);
    // Black thinks too long.
    t.tick(T0 + 50_000 + 59_999);
    expect(g.result).toBeNull();
    t.tick(T0 + 50_000 + 60_000);
    expect(g.result).toEqual({ winner: g.white, reason: "timeout" });
    expect(g.clocks.b).toBe(0);
  });

  it("pausing freezes the clocks, resuming continues them", () => {
    const { t, table } = oneBoard({ minutes: 1, incrementSeconds: 0 });
    const g = table.game!;
    t.act(g.white, { type: "move", uci: "e2e4" }, T0);
    t.act(g.black, { type: "move", uci: "e7e5" }, T0);
    t.pause("test", T0 + 50_000);
    t.tick(T0 + 500_000);
    expect(() => t.act(g.white, { type: "move", uci: "g1f3" }, T0 + 500_000)).toThrow("paused");
    t.resume(T0 + 500_000);
    t.tick(T0 + 509_000); // 50 s before the pause + 9 s now
    expect(g.result).toBeNull();
    t.tick(T0 + 510_000);
    expect(g.result?.reason).toBe("timeout");
  });

  it("comes back paused mid-game after a restart and plays on to the end", () => {
    const t = make(9, { winsToAdvance: 1 }, 5);
    t.start(T0);
    let now = T0;
    const rng = seededRandom(3);
    for (let i = 0; i < 30; i++) {
      for (const table of t.tables.values()) {
        const g = table.game;
        if (g && !g.result) {
          const moves = legalUci(g.chess);
          t.act(toMove(table), { type: "move", uci: moves[Math.floor(rng() * moves.length)]! }, now);
        }
      }
      now += 300;
      t.tick(now);
    }
    t.meta.savedAt = now;
    const saved = JSON.parse(JSON.stringify({ meta: t.meta, tables: [...t.tables.values()] })) as { meta: Tournament["meta"]; tables: TableState[] };
    const restored = new Tournament(saved.meta, new Map(saved.tables.map((tb) => [tb.id, tb])), noopHooks, seededRandom(9));
    restored.restoreAfterRestart();
    expect(restored.meta.paused).toBe(true);
    expect([...restored.tables.values()].map((tb) => tb.game?.chess.uci)).toEqual([...t.tables.values()].map((tb) => tb.game?.chess.uci));
    restored.resume(now + 10_000);
    playOut(restored, now + 10_000);
    expect(restored.meta.status).toBe("finished");
    expectPlacesComplete(restored);
  });
});

describe("players", () => {
  it("removing a player gives their opponent the match", () => {
    const t = make(4);
    t.start(T0);
    t.tick(T0);
    const table = [...t.tables.values()][0]!;
    const [a, b] = table.seats.map((s) => s!.userId) as [number, number];
    t.kick(a, T0);
    expect(t.meta.entrants[a]!.place).toBe(4);
    expect(t.tables.has(table.id)).toBe(false);
    expect(t.meta.entrants[b]!.advancedTo).not.toBeNull();
    playOut(t, T0);
    expect(t.meta.status).toBe("finished");
    expectPlacesComplete(t);
  });

  it("cancelling closes every board", () => {
    const t = make(10);
    t.start(T0);
    t.cancel(T0 + 1);
    expect(t.meta.status).toBe("cancelled");
    expect(t.tables.size).toBe(0);
    expect(() => t.cancel(T0 + 2)).toThrow();
  });

  it("shows everyone the board but only the player to move their legal moves", () => {
    const { t, table } = oneBoard();
    const g = table.game!;
    const white = t.tableView(table.id, g.white, T0)!;
    const black = t.tableView(table.id, g.black, T0)!;
    const spectator = t.tableView(table.id, null, T0)!;
    expect(white.legal).toHaveLength(20);
    expect(black.legal).toEqual([]);
    expect(spectator.legal).toEqual([]);
    expect(white.myColor).toBe("w");
    expect(black.myColor).toBe("b");
    expect(spectator.board).toEqual(white.board);
  });
});
