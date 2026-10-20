import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Store and db read config on import, so point them at a throwaway database first.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "flappy-tournament-")), "test.db");
process.env.HUB_SECRET = "";

const { TICK_MS, autopilot, simulate } = await import("../src/shared/engine/flappy.ts");
const { COLLECT_MS, FINALE_COUNTDOWN_MS, GRACE_TICKS, Tournament, TournamentError } = await import("../src/server/tournament/tournament.ts");

const T0 = 1_000_000;
const MIN = 60_000;
const player = (id: number) => ({ id, username: `P${id}`, avatarUrl: "" });

function setup(opts: { players?: number; minutes?: number; seed?: number } = {}) {
  const finished: { userId: number; place: number }[][] = [];
  const t = Tournament.create(1, { name: "Test", startTime: T0, maxPlayers: 10, durationMinutes: opts.minutes ?? 2 }, opts.seed ?? 77, T0 - MIN, {
    lobbyChanged: () => {},
    changed: () => {},
    dirty: () => {},
    tournamentFinished: (rows) => finished.push(rows),
  });
  for (let i = 1; i <= (opts.players ?? 3); i++) t.register(player(i), T0 - MIN);
  return { t, finished };
}

/** Flies a run that really lasts as long as its ticks (the server's clock agrees). */
function fly(t: InstanceType<typeof Tournament>, userId: number, flaps: number[], at: number, ticks?: number) {
  t.startRun(userId, at);
  const length = ticks ?? simulate(t.meta.seed, flaps).distance;
  return t.endRun(userId, flaps, at + length * TICK_MS);
}

describe("lifecycle", () => {
  it("starts by itself at the start time with two players, and the clock runs for the time limit", () => {
    const { t } = setup({ minutes: 3 });
    t.tick(T0 - 1);
    expect(t.meta.status).toBe("registering");
    t.tick(T0);
    expect(t.meta.status).toBe("running");
    expect(t.meta.endsAt).toBe(T0 + 3 * MIN);
  });

  it("needs two players", () => {
    const { t } = setup({ players: 1 });
    expect(() => t.start(T0)).toThrow(TournamentError);
  });

  it("hides the course until it starts", () => {
    const { t } = setup();
    expect(t.view(1, T0).seed).toBeNull();
    t.start(T0);
    expect(t.view(1, T0).seed).toBe(77);
  });
});

describe("runs", () => {
  it("keeps only each player's best run, and counts attempts", () => {
    const { t } = setup();
    t.start(T0);
    const good = autopilot(77, 2000);
    expect(fly(t, 1, [], T0 + 1000).newBest).toBe(true);
    const r = fly(t, 1, good, T0 + 5000);
    expect(r.newBest).toBe(true);
    expect(fly(t, 1, [], T0 + 60_000).newBest).toBe(false);
    expect(t.meta.entrants[1]!.best!.distance).toBe(r.distance);
    expect(t.meta.entrants[1]!.attempts).toBe(3);
  });

  it("works out the score itself instead of trusting the player", () => {
    const { t } = setup();
    t.start(T0);
    const r = fly(t, 1, [], T0 + 1000);
    expect(r).toMatchObject({ score: 0 });
    expect(r.distance).toBe(simulate(77, []).distance);
  });

  it("doesn't count more flying than the time that really passed", () => {
    const { t } = setup();
    t.start(T0);
    const flaps = autopilot(77, 5000);
    t.startRun(1, T0 + 1000);
    // Claims a long run but only one second passed.
    const r = t.endRun(1, flaps, T0 + 2000);
    expect(r.distance).toBeLessThanOrEqual(60 + GRACE_TICKS);
  });

  it("rejects a run that was never started, or a broken one", () => {
    const { t } = setup();
    t.start(T0);
    expect(() => t.endRun(1, [], T0 + 1000)).toThrow(TournamentError);
    t.startRun(1, T0 + 1000);
    expect(() => t.endRun(1, [3, 2], T0 + 2000)).toThrow(TournamentError);
  });

  it("cuts a run off when the clock runs out", () => {
    const { t } = setup({ minutes: 1 });
    t.start(T0);
    const flaps = autopilot(77, 60 * 60);
    const startAt = T0 + MIN - 10_000; // 10 seconds left
    t.startRun(1, startAt);
    const r = t.endRun(1, flaps, T0 + MIN + 1000);
    expect(r.distance).toBeLessThanOrEqual(600 + GRACE_TICKS);
    expect(r.distance).toBeGreaterThanOrEqual(590);
  });

  it("won't start a run after time is up", () => {
    const { t } = setup({ minutes: 1 });
    t.start(T0);
    expect(() => t.startRun(1, T0 + MIN)).toThrow(TournamentError);
  });

  it("lets players join late while the clock runs, but not after", () => {
    const { t } = setup({ minutes: 1 });
    t.start(T0);
    t.register(player(8), T0 + 30_000);
    expect(t.meta.entrants[8]).toBeDefined();
    expect(() => t.register(player(9), T0 + MIN)).toThrow(TournamentError);
  });

  it("never shows other players' scores before the finale", () => {
    const { t } = setup();
    t.start(T0);
    fly(t, 1, autopilot(77, 2000), T0 + 1000);
    const v = JSON.stringify(t.view(2, T0 + 60_000));
    expect(v).not.toContain('"distance"');
    expect(t.view(1, T0 + 60_000).me!.best).not.toBeNull();
  });
});

describe("pause and restart", () => {
  it("pause freezes the clock and resume gives back the time left", () => {
    const { t } = setup({ minutes: 2 });
    t.start(T0);
    t.pause("test", T0 + 30_000);
    expect(t.summary(1, T0 + 40_000).remainingMs).toBe(90_000);
    expect(() => t.startRun(1, T0 + 40_000)).toThrow(TournamentError);
    t.resume(T0 + 100_000);
    expect(t.meta.endsAt).toBe(T0 + 2 * MIN + 70_000);
  });

  it("a run in the air when the pause starts counts up to the pause", () => {
    const { t } = setup();
    t.start(T0);
    const flaps = autopilot(77, 5000);
    t.startRun(1, T0 + 1000);
    t.pause("test", T0 + 6000);
    const r = t.endRun(1, flaps, T0 + 7000);
    expect(r.distance).toBeLessThanOrEqual(300 + GRACE_TICKS);
  });

  it("comes back paused after a restart", () => {
    const { t } = setup();
    t.start(T0);
    t.meta.savedAt = T0 + 20_000;
    const copy = new Tournament(structuredClone(t.meta));
    copy.restoreAfterRestart(T0 + 99_000);
    expect(copy.meta.paused).toBe(true);
    expect(copy.summary(null, T0 + 99_000).remainingMs).toBe(2 * MIN - 20_000);
  });

  it("an interrupted finale goes straight to the results", () => {
    const { t, finished } = setup({ minutes: 1 });
    t.start(T0);
    fly(t, 1, [], T0 + 1000);
    t.tick(T0 + MIN + COLLECT_MS);
    expect(t.meta.status).toBe("finale");
    const copy = new Tournament(structuredClone(t.meta), { ...t.hooks });
    copy.restoreAfterRestart(T0 + MIN + 10_000);
    expect(copy.meta.status).toBe("finished");
    expect(finished).toHaveLength(1);
  });
});

describe("finale and results", () => {
  it("replays everyone's best, then ranks furthest first, ties to whoever was first, no-shows last", () => {
    const { t, finished } = setup({ players: 4, minutes: 2 });
    t.start(T0);
    const good = autopilot(77, 3000);
    fly(t, 2, good, T0 + 1000);
    fly(t, 1, [], T0 + 2000);
    fly(t, 3, [], T0 + 1500); // same distance as player 1, but earlier
    // Player 4 never flies.

    t.tick(T0 + 2 * MIN); // time's up, nobody in the air: straight to the finale
    expect(t.meta.status).toBe("finale");
    const f = t.meta.finale!;
    expect(f.ghosts.map((g) => g.userId)).toEqual([2, 3, 1]);
    expect(f.speed).toBeGreaterThanOrEqual(2);
    expect(f.startsAt).toBe(T0 + 2 * MIN + FINALE_COUNTDOWN_MS);
    // The hub isn't told until the replay is over.
    expect(finished).toHaveLength(0);

    t.tick(f.endsAt);
    expect(t.meta.status).toBe("finished");
    expect(finished[0]).toEqual([
      { userId: 2, place: 1 },
      { userId: 3, place: 2 },
      { userId: 1, place: 3 },
      { userId: 4, place: 4 },
    ]);
    expect(t.view(4, f.endsAt).results!.map((r) => r.place)).toEqual([1, 2, 3, 4]);
  });

  it("waits a moment for runs still being sent when the clock hits zero", () => {
    const { t } = setup({ minutes: 1 });
    t.start(T0);
    t.startRun(1, T0 + MIN - 5000);
    t.tick(T0 + MIN);
    expect(t.meta.status).toBe("running");
    t.endRun(1, autopilot(77, 1000), T0 + MIN + 500);
    t.tick(T0 + MIN + 600);
    expect(t.meta.status).toBe("finale");
    expect(t.meta.finale!.ghosts).toHaveLength(1);
  });

  it("kicked players lose their runs and come last", () => {
    const { t, finished } = setup({ players: 3, minutes: 1 });
    t.start(T0);
    fly(t, 1, autopilot(77, 2000), T0 + 1000);
    fly(t, 2, [], T0 + 1000);
    t.kick(1, T0 + 20_000);
    t.tick(T0 + MIN);
    expect(t.meta.finale!.ghosts.map((g) => g.userId)).toEqual([2]);
    t.tick(t.meta.finale!.endsAt);
    expect(finished[0]).toEqual([
      { userId: 2, place: 1 },
      { userId: 3, place: 2 },
      { userId: 1, place: 3 },
    ]);
  });
});
