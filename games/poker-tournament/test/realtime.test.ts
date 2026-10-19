// Spectating over the WebSocket hub, with fake sockets that record every frame: who gets which cards,
// who gets which chat, following a player, and viewer counts.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Config reads the environment on import, so point it at a throwaway database before loading the server.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "poker-realtime-")), "test.db");
process.env.HUB_SECRET = "";

const { Realtime } = await import("../src/server/realtime.ts");
const { TournamentManager } = await import("../src/server/tournament/manager.ts");

type Frame = { type: string; [k: string]: any };

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  frames: Frame[] = [];
  private handlers = new Map<string, (...args: any[]) => void>();
  send(data: string) {
    this.frames.push(JSON.parse(data));
  }
  on(event: string, fn: (...args: any[]) => void) {
    this.handlers.set(event, fn);
  }
  ping() {}
  terminate() {}
  close() {
    this.readyState = 3;
    this.handlers.get("close")?.();
  }
  emit(msg: object) {
    this.handlers.get("message")!(Buffer.from(JSON.stringify(msg)));
  }
  of(type: string) {
    return this.frames.filter((f) => f.type === type);
  }
  raw() {
    return this.frames.map((f) => JSON.stringify(f)).join("\n");
  }
}

const CARD = /"[2-9TJQKA][cdhs]"/g;
const cardsIn = (s: FakeSocket) => new Set(s.raw().match(CARD)?.map((c) => c.slice(1, -1)) ?? []);
const flush = () => new Promise((r) => setImmediate(r));
const user = (id: number, isAdmin = false) => ({ id, username: `u${id}`, avatarUrl: "", isAdmin });

/** A running 7-player tournament (two tables), before anyone has acted. */
function setup() {
  const rt = new Realtime();
  const manager = new TournamentManager(rt);
  rt.manager = manager;
  const now = Date.now();
  const t = manager.create({ name: "Watch test", startTime: now }, now);
  for (let i = 1; i <= 7; i++) t.register({ id: i, username: `u${i}`, avatarUrl: "" }, now);
  t.tick(now);
  const [tb1, tb2] = [...t.tables.values()];
  const seatedAt = (tb: typeof tb1) => tb!.seats.flatMap((s) => (s ? [s.userId] : []));
  const holeCards = (userId: number) => [...t.tables.values()].flatMap((tb) => tb.hand?.players.find((p) => p.playerId === String(userId))?.holeCards ?? []);
  const connect = (u: ReturnType<typeof user>) => {
    const s = new FakeSocket();
    rt.connect(s, u);
    return s;
  };
  const watch = (s: FakeSocket, tableId: number | null) => s.emit({ type: "watch", tournamentId: t.id, tableId });
  return { rt, t, tb1: tb1!, tb2: tb2!, seated1: seatedAt(tb1), seated2: seatedAt(tb2), holeCards, connect, watch };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("who sees which cards", () => {
  it("only an admin who isn't playing ever receives other players' cards", async () => {
    const { rt, t, tb1, seated1, seated2, holeCards, connect, watch } = setup();
    const player = seated1[0]!;
    const sPlayer = connect(user(player));
    const sSpectator = connect(user(50));
    const sHost = connect(user(99, true));
    // An admin who is playing at the other table, watching this one.
    const playingAdmin = seated2[0]!;
    const sPlayingAdmin = connect(user(playingAdmin, true));
    for (const s of [sSpectator, sHost, sPlayingAdmin]) watch(s, tb1.id);
    rt.tableChanged(t.id, tb1.id);
    await flush();

    const tableCards = seated1.flatMap(holeCards);
    expect(tableCards.length).toBe(seated1.length * 2);
    // Before the flop no card is public, so any card in a frame must be one the person may see.
    expect([...cardsIn(sPlayer)].sort()).toEqual([...holeCards(player)].sort());
    expect(cardsIn(sSpectator).size).toBe(0);
    expect([...cardsIn(sPlayingAdmin)].sort()).toEqual([...holeCards(playingAdmin)].sort());
    expect([...cardsIn(sHost)].sort()).toEqual([...tableCards].sort());
    expect(sHost.of("table").every((f) => f.view.hostView === true)).toBe(true);
    expect(sSpectator.of("table").every((f) => f.view.hostView === false)).toBe(true);
  });
});

describe("spectator chat", () => {
  it("never reaches players seated at the table; the host can still talk to them", async () => {
    const { t, tb1, seated1, connect, watch } = setup();
    const sPlayer = connect(user(seated1[0]!));
    const sSpectator = connect(user(50));
    const sHost = connect(user(99, true));
    watch(sSpectator, tb1.id);
    watch(sHost, tb1.id);
    const chat = (s: FakeSocket, channel: string | undefined, text: string) => s.emit({ type: "chat", tournamentId: t.id, tableId: tb1.id, channel, text });

    chat(sSpectator, "spectators", "what a call");
    chat(sSpectator, undefined, "no channel: goes to spectators");
    chat(sSpectator, "table", "fold!");
    chat(sHost, "table", "Break in 5 minutes");
    chat(sPlayer, "spectators", "psst");

    const texts = (s: FakeSocket, channel: string) => s.of("chat").filter((f) => f.channel === channel).flatMap((f) => f.messages.map((m: any) => m.text));
    expect(texts(sPlayer, "spectators")).toEqual([]);
    expect(sPlayer.raw()).not.toContain("what a call");
    expect(texts(sSpectator, "spectators")).toEqual(["what a call", "no channel: goes to spectators"]);
    expect(texts(sPlayer, "table")).toEqual(["Break in 5 minutes"]);
    expect(sPlayer.of("chat").flatMap((f) => f.messages).find((m: any) => m.text === "Break in 5 minutes").kind).toBe("host");
    expect(sSpectator.of("error").map((f) => f.message)).toEqual(["Only players and the host talk in the table chat"]);
    expect(sPlayer.of("error").map((f) => f.message)).toEqual(["Players can't post in the spectator chat"]);
  });
});

describe("following a player", () => {
  it("sends followers along, tells them when the player is out, and auto-follows a table's winner", async () => {
    const { rt, t, tb1, seated1, connect, watch } = setup();
    const target = seated1[0]!;
    const sFan = connect(user(50));
    const sOther = connect(user(51));
    watch(sOther, tb1.id);

    // Players still in can't follow anyone.
    const sPlayer = connect(user(seated1[1]!));
    sPlayer.emit({ type: "follow", tournamentId: t.id, userId: target });
    expect(sPlayer.of("error")).toHaveLength(1);

    sFan.emit({ type: "follow", tournamentId: t.id, userId: target });
    expect(sFan.of("follow").at(-1)!.following).toMatchObject({ userId: target, tableId: tb1.id });

    rt.playerMoved(t.id, target, 42);
    expect(sFan.of("follow").at(-1)!.notice).toBe(`u${target} moved to table 42.`);
    rt.playerAdvanced(t.id, target, 2, 3);
    expect(sFan.of("follow").at(-1)!.notice).toMatch(/won their table/);

    rt.playerFinished(t.id, target, 5, 0);
    const last = sFan.of("follow").at(-1)!;
    expect(last.following).toBeNull();
    expect(last.notice).toMatch(/knocked out \(5th\)/);
    expect(rt.follows.target(t.id, 50)).toBeNull();

    // The table closes: whoever was watching (and isn't playing) follows the winner.
    const winner = seated1[2]!;
    rt.tableClosed(t.id, tb1.id, winner);
    expect(sOther.of("follow").at(-1)).toMatchObject({ following: { userId: winner }, notice: `This table is over. Now following the winner, u${winner}.` });

    // A follow survives reconnecting.
    sOther.close();
    const again = connect(user(51));
    expect(again.of("follow").at(-1)!.following.userId).toBe(winner);
  });
});

describe("viewer counts", () => {
  it("counts each person once, leaves out players, and sends changes at most every few seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { rt, t, tb2, seated2, connect, watch } = setup();
    const sPlayer = connect(user(seated2[0]!));
    const tabA = connect(user(60));
    const tabB = connect(user(60));
    const other = connect(user(61));
    for (const s of [tabA, tabB, other]) watch(s, tb2.id);

    expect(rt.viewerCount(t.id, tb2.id)).toBe(2);
    expect(t.detail(null).tables.find((x) => x.id === tb2.id)!.viewers).toBe(2);
    // A new watcher is told the count straight away; everyone else gets one update after the throttle.
    expect(other.of("viewers").at(-1)!.count).toBe(2);
    const before = sPlayer.of("viewers").length;
    vi.advanceTimersByTime(3000);
    expect(sPlayer.of("viewers").slice(before).map((f) => f.count)).toEqual([2]);

    // Closing one of two tabs changes nothing; leaving the page does.
    tabA.close();
    vi.advanceTimersByTime(3000);
    expect(sPlayer.of("viewers").length).toBe(before + 1);
    watch(other, null);
    vi.advanceTimersByTime(3000);
    expect(sPlayer.of("viewers").at(-1)!.count).toBe(1);
  });
});
