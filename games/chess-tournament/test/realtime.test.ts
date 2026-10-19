// Spectating over the WebSocket hub, with fake sockets that record every frame: what spectators are
// sent, who gets which chat, following a player, and viewer counts.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Config reads the environment on import, so point it at a throwaway database before loading the server.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "chess-realtime-")), "test.db");
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

const flush = () => new Promise((r) => setImmediate(r));
const user = (id: number, isAdmin = false) => ({ id, username: `u${id}`, avatarUrl: "", isAdmin });

/** A running 4-player tournament: two boards. */
function setup() {
  const rt = new Realtime();
  const manager = new TournamentManager(rt);
  rt.manager = manager;
  const now = Date.now();
  const t = manager.create({ name: "Watch test", startTime: now }, now);
  for (let i = 1; i <= 4; i++) t.register({ id: i, username: `u${i}`, avatarUrl: "" }, now);
  let at = now;
  t.tick(at);
  while ([...t.tables.values()].some((tb) => !tb.game) && at < now + 60_000) t.tick((at += 500));
  const [tb1, tb2] = [...t.tables.values()];
  const seatedAt = (tb: typeof tb1) => tb!.seats.flatMap((s) => (s ? [s.userId] : []));
  const connect = (u: ReturnType<typeof user>) => {
    const s = new FakeSocket();
    rt.connect(s, u);
    return s;
  };
  const watch = (s: FakeSocket, tableId: number | null) => s.emit({ type: "watch", tournamentId: t.id, tableId });
  return { rt, t, tb1: tb1!, tb2: tb2!, seated1: seatedAt(tb1), seated2: seatedAt(tb2), connect, watch };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("what spectators are sent", () => {
  it("the board, without anyone's legal moves", async () => {
    const { rt, t, tb1, connect, watch } = setup();
    const sSpectator = connect(user(50));
    const sAdmin = connect(user(99, true));
    watch(sSpectator, tb1.id);
    watch(sAdmin, tb1.id);
    rt.tableChanged(t.id, tb1.id);
    await flush();
    for (const s of [sSpectator, sAdmin]) {
      const views = s.of("table").map((f) => f.view);
      expect(views.length).toBeGreaterThan(0);
      for (const v of views) {
        expect(v.legal).toEqual([]);
        expect(v.mySeat).toBeNull();
      }
    }
  });
});

describe("spectator chat", () => {
  it("never reaches the players at the board; the host can still talk to them", () => {
    const { t, tb1, seated1, connect, watch } = setup();
    const sPlayer = connect(user(seated1[0]!));
    const sSpectator = connect(user(50));
    const sHost = connect(user(99, true));
    watch(sSpectator, tb1.id);
    watch(sHost, tb1.id);
    const chat = (s: FakeSocket, channel: string | undefined, text: string) => s.emit({ type: "chat", tournamentId: t.id, tableId: tb1.id, channel, text });

    chat(sSpectator, "spectators", "Nf3 wins a piece");
    chat(sSpectator, undefined, "no channel: goes to spectators");
    chat(sSpectator, "table", "play Nf3!");
    chat(sHost, "table", "Round 2 starts soon");

    expect(sPlayer.raw()).not.toContain("Nf3");
    expect(sPlayer.raw()).not.toContain("no channel");
    expect(sSpectator.raw()).toContain("Nf3 wins a piece");
    expect(sPlayer.of("chat").flatMap((f) => f.messages).find((m: any) => m.text === "Round 2 starts soon").kind).toBe("host");
    expect(sSpectator.of("error").map((f) => f.message)).toEqual(["Only players and the host talk in the board chat"]);
  });
});

describe("following a player", () => {
  it("sends followers along, tells them when the player is out, and auto-follows a match's winner", () => {
    const { rt, t, tb1, seated1, connect, watch } = setup();
    const target = seated1[0]!;
    const sFan = connect(user(50));
    const sOther = connect(user(51));
    watch(sOther, tb1.id);

    sFan.emit({ type: "follow", tournamentId: t.id, userId: target });
    expect(sFan.of("follow").at(-1)!.following).toMatchObject({ userId: target, tableId: tb1.id });
    rt.playerAdvanced(t.id, target, 2, 2, false);
    expect(sFan.of("follow").at(-1)!.notice).toMatch(/won their match\. Waiting for the final/);
    rt.playerMoved(t.id, target, 3);
    expect(sFan.of("follow").at(-1)!.notice).toBe(`u${target}'s next match is on board 3.`);
    rt.playerFinished(t.id, target, 2);
    expect(sFan.of("follow").at(-1)!.following).toBeNull();

    const winner = seated1[1]!;
    rt.tableClosed(t.id, tb1.id, winner);
    expect(sOther.of("follow").at(-1)!.following.userId).toBe(winner);
  });
});

describe("viewer counts", () => {
  it("counts each person once and leaves out players", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { rt, t, tb2, seated2, connect, watch } = setup();
    const sPlayer = connect(user(seated2[0]!));
    for (const s of [connect(user(60)), connect(user(60)), connect(user(61))]) watch(s, tb2.id);
    expect(rt.viewerCount(t.id, tb2.id)).toBe(2);
    expect(t.detail(null).tables.find((x) => x.id === tb2.id)!.viewers).toBe(2);
    vi.advanceTimersByTime(3000);
    expect(sPlayer.of("viewers").at(-1)!.count).toBe(2);
  });
});
