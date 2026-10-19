import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Config reads the environment on import, so point it at a throwaway database before loading the server.
const SECRET = "test-secret";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "poker-integration-")), "test.db");
process.env.HUB_SECRET = SECRET;
process.env.HUB_URL = "http://hub.test/";
process.env.PUBLIC_URL = "https://poker.example";

const { default: Fastify } = await import("fastify");
const { config } = await import("../src/server/config.ts");
const { db, upsertUser } = await import("../src/server/db.ts");
const { hubSignature, registerIntegrationRoutes } = await import("../src/server/integration.ts");
const { TournamentManager } = await import("../src/server/tournament/manager.ts");
const { legalActions } = await import("../src/shared/engine/hand.ts");

const notifier = {
  isConnected: () => true,
  tableChanged: () => {},
  tableClosed: () => {},
  viewerCount: () => 0,
  lobbyChanged: () => {},
  playerMoved: () => {},
  playerAdvanced: () => {},
  playerFinished: () => {},
  handComplete: () => {},
};
const manager = new TournamentManager(notifier);
const app = Fastify();
const onShutdown = vi.fn();
registerIntegrationRoutes(app, manager, onShutdown);

beforeAll(() => app.ready());
afterAll(async () => {
  manager.stop();
  await app.close();
  db.close();
});
afterEach(() => {
  vi.unstubAllGlobals();
  config.hub.secret = SECRET;
});

function hub(method: "GET" | "POST", url: string, body?: unknown, opts: { timestamp?: number; secret?: string; rawBody?: string } = {}) {
  const raw = opts.rawBody ?? (body === undefined ? "" : JSON.stringify(body));
  const timestamp = String(opts.timestamp ?? Date.now());
  return app.inject({
    method,
    url,
    payload: raw || undefined,
    headers: {
      ...(raw || opts.rawBody !== undefined ? { "content-type": "application/json" } : {}),
      "x-hub-timestamp": timestamp,
      "x-hub-signature": hubSignature(opts.secret ?? SECRET, timestamp, raw),
    },
  });
}

describe("signatures", () => {
  it("accepts a correctly signed request", async () => {
    const res = await hub("GET", "/api/integration/info");
    expect(res.statusCode).toBe(200);
    const info = res.json();
    expect(info).toMatchObject({ key: "poker", name: "Poker Night" });
    expect(info.fields.map((f: { name: string }) => f.name)).toEqual([
      "name", "startTime", "access", "maxPlayers", "startingStack", "chipMode", "levels", "breakEveryLevels",
      "breakMinutes", "decisionSeconds", "timeBankSeconds", "payoutPercent",
    ]);
    expect(info.fields.find((f: { name: string }) => f.name === "maxPlayers").options.map((o: { value: number }) => o.value)).toEqual([6, 36, 216, 1296]);
  });

  it("rejects a wrong signature, a missing one and a tampered body", async () => {
    expect((await hub("GET", "/api/integration/info", undefined, { secret: "nope" })).json()).toEqual({ error: "bad_signature" });
    const missing = await app.inject({ method: "GET", url: "/api/integration/info" });
    expect(missing.statusCode).toBe(401);
    const timestamp = String(Date.now());
    const tampered = await app.inject({
      method: "POST",
      url: "/api/integration/events",
      payload: JSON.stringify({ name: "Evil" }),
      headers: { "content-type": "application/json", "x-hub-timestamp": timestamp, "x-hub-signature": hubSignature(SECRET, timestamp, JSON.stringify({ name: "Nice" })) },
    });
    expect(tampered.statusCode).toBe(401);
  });

  it("rejects a stale timestamp", async () => {
    const res = await hub("GET", "/api/integration/info", undefined, { timestamp: Date.now() - 6 * 60_000 });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "bad_signature" });
  });

  it("is disabled without a secret", async () => {
    config.hub.secret = "";
    const res = await hub("GET", "/api/integration/info");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "integration_disabled" });
  });
});

describe("events", () => {
  it("creates, lists, controls, finishes and reports results, then notifies the hub", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const created = await hub("POST", "/api/integration/events", { name: "Hub Cup", startTime: Date.now() + 3_600_000, maxPlayers: 6 });
    expect(created.statusCode).toBe(200);
    const ev = created.json();
    expect(ev).toMatchObject({ name: "Hub Cup", status: "registering", entrants: 0, maxPlayers: 6, startedAt: null, finishedAt: null });
    expect(typeof ev.id).toBe("string");
    expect(ev.url).toBe(`https://poker.example/#/t/${ev.id}`);
    // The spectator link only exists while it's running.
    expect(ev.watchUrl).toBeNull();

    const listed = await hub("GET", "/api/integration/events?status=registering");
    expect(listed.json().map((e: { id: string }) => e.id)).toContain(ev.id);
    expect((await hub("GET", "/api/integration/events?status=bogus")).statusCode).toBe(400);

    // Starting with nobody registered is a tournament error, reported as 400.
    const tooFew = await hub("POST", `/api/integration/events/${ev.id}/start`);
    expect(tooFew.statusCode).toBe(400);
    expect(tooFew.json().error).toBeTypeOf("string");
    expect((await hub("POST", "/api/integration/events/99999/start")).statusCode).toBe(404);
    expect((await hub("POST", `/api/integration/events/${ev.id}/kick`)).statusCode).toBe(404);

    const t = manager.get(Number(ev.id))!;
    const alice = upsertUser("1001", "alice", null);
    const bob = upsertUser("1002", "bob", null);
    t.register({ id: alice.id, username: alice.username, avatarUrl: "" }, Date.now());
    t.register({ id: bob.id, username: bob.username, avatarUrl: "" }, Date.now());

    // A signed empty JSON body is fine for ops.
    const started = await hub("POST", `/api/integration/events/${ev.id}/start`, undefined, { rawBody: "" });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ status: "running", entrants: 2 });
    expect(started.json().startedAt).toBeTypeOf("number");
    expect(started.json().watchUrl).toBe(`https://poker.example/#/t/${ev.id}/watch`);
    expect((await hub("POST", `/api/integration/events/${ev.id}/pause`, {})).statusCode).toBe(200);
    expect(t.meta.paused).toBe(true);
    expect((await hub("POST", `/api/integration/events/${ev.id}/resume`, {})).statusCode).toBe(200);
    expect(t.meta.paused).toBe(false);

    // Both players shove every hand until one has all the chips.
    let now = Date.now();
    for (let i = 0; i < 20_000 && t.meta.status === "running"; i++) {
      now += 1000;
      const hand = [...t.tables.values()][0]?.hand;
      if (hand && hand.toAct !== null) {
        const l = legalActions(hand)!;
        const who = Number(hand.players[hand.toAct]!.playerId);
        t.act(who, l.canRaise ? { type: "raise", to: l.maxRaiseTo } : l.canCheck ? { type: "check" } : { type: "call" }, now);
      }
      t.tick(now);
    }
    expect(t.meta.status).toBe("finished");

    const finishedCalls = fetchMock.mock.calls.filter(([, i]) => JSON.parse(i.body as string).type === "event.finished");
    expect(finishedCalls).toHaveLength(1);
    const [url, init] = finishedCalls[0]!;
    expect(url).toBe("http://hub.test/api/games/poker/webhook");
    const headers = init.headers as Record<string, string>;
    expect(JSON.parse(init.body as string)).toEqual({ type: "event.finished", externalId: ev.id });
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-hub-signature"]).toBe(hubSignature(SECRET, headers["x-hub-timestamp"]!, init.body as string));

    // Results come from the database, so they survive the tournament leaving memory.
    manager.tournaments.delete(t.id);
    const results = await hub("GET", `/api/integration/events/${ev.id}/results`);
    expect(results.statusCode).toBe(200);
    const body = results.json();
    expect(body).toMatchObject({ id: ev.id, status: "finished", finishedAt: t.meta.finishedAt });
    expect(body.results.map((r: { place: number }) => r.place)).toEqual([1, 2]);
    expect(body.results.map((r: { discordId: string }) => r.discordId).sort()).toEqual(["1001", "1002"]);

    const finished = (await hub("GET", "/api/integration/events?status=finished")).json();
    expect(finished.map((e: { id: string }) => e.id)).toContain(ev.id);
    const sinceLater = (await hub("GET", `/api/integration/events?status=finished&since=${t.meta.finishedAt! + 1}`)).json();
    expect(sinceLater.map((e: { id: string }) => e.id)).not.toContain(ev.id);
    expect((await hub("POST", `/api/integration/events/${ev.id}/cancel`)).statusCode).toBe(400);
    expect((await hub("GET", "/api/integration/events/99999/results")).statusCode).toBe(404);
  });

  it("cancels an event without notifying the hub", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const ev = (await hub("POST", "/api/integration/events", { name: "Short-lived" })).json();
    const res = await hub("POST", `/api/integration/events/${ev.id}/cancel`);
    expect(res.json()).toMatchObject({ status: "cancelled" });
    expect(res.json().finishedAt).toBeTypeOf("number");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("shutdown", () => {
  it("stops the server only for a signed request, after answering", async () => {
    const unsigned = await app.inject({ method: "POST", url: "/api/integration/shutdown" });
    expect(unsigned.statusCode).toBe(401);
    const res = await hub("POST", "/api/integration/shutdown", {});
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });
});

describe("blind structures from the hub", () => {
  it("offers a blind editor with presets in the create form", async () => {
    const info = (await hub("GET", "/api/integration/info")).json();
    const blinds = info.fields.find((f: { name: string }) => f.name === "levels");
    expect(blinds.type).toBe("blinds");
    expect(blinds.presets.map((p: { name: string }) => p.name)).toEqual(["Standard", "Turbo", "Hyper Turbo", "Deep Stack", "Casual Evening"]);
  });

  it("uses a custom structure, and explains what's wrong with a bad one", async () => {
    const levels = [
      { smallBlind: 10, bigBlind: 20, ante: 0, minutes: 7 },
      { smallBlind: 20, bigBlind: 40, ante: 5, minutes: 7 },
      { smallBlind: 50, bigBlind: 100, ante: 10, minutes: 4 },
    ];
    const ok = await hub("POST", "/api/integration/events", { name: "Custom", startTime: Date.now() + 3_600_000, maxPlayers: 6, levels });
    expect(ok.statusCode).toBe(200);
    expect(manager.get(Number(ok.json().id))!.config.levels).toEqual(levels);

    const bad = await hub("POST", "/api/integration/events", { name: "Bad", levels: [levels[1], levels[0]] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/Level 2: blinds can't go down/);
  });
});

describe("lobby", () => {
  const statuses = (lobby: { players: { discordId: string; status: string }[] }) => lobby.players.map((p) => `${p.discordId}:${p.status}`).sort();

  it("a closed lobby queues join requests; the hub lets players in, turns them down, kicks them and opens it", async () => {
    const ev = (await hub("POST", "/api/integration/events", { name: "Invite only", startTime: Date.now() + 3_600_000, access: "closed" })).json();
    expect(ev).toMatchObject({ access: "closed", pending: 0, entrants: 0 });
    const t = manager.get(Number(ev.id))!;
    const [a, b, c] = ["7001", "7002", "7003"].map((d, i) => upsertUser(d, `lobby${i}`, null));
    for (const u of [a!, b!, c!]) t.register({ id: u.id, username: u.username, avatarUrl: "" }, Date.now());
    expect(t.entrantCount).toBe(0);
    expect(t.summary(a!.id).me).toMatchObject({ registered: false, pending: true, removed: false });
    expect(t.summary(null)).toMatchObject({ access: "closed" });

    let res = await hub("GET", `/api/integration/events/${ev.id}/players`);
    expect(res.json().access).toBe("closed");
    expect(statuses(res.json())).toEqual(["7001:pending", "7002:pending", "7003:pending"]);
    expect((await hub("GET", "/api/integration/events")).json().find((e: { id: string }) => e.id === ev.id)).toMatchObject({ pending: 3 });

    res = await hub("POST", `/api/integration/events/${ev.id}/players/7001/approve`, {});
    expect(res.statusCode).toBe(200);
    res = await hub("POST", `/api/integration/events/${ev.id}/players/7002/deny`, {});
    expect(statuses(res.json())).toEqual(["7001:registered", "7003:pending"]);
    expect(t.entrantCount).toBe(1);

    // Kicked players leave the field and can't come back.
    res = await hub("POST", `/api/integration/events/${ev.id}/players/7001/kick`, {});
    expect(statuses(res.json())).toEqual(["7003:pending"]);
    expect(() => t.register({ id: a!.id, username: a!.username, avatarUrl: "" }, Date.now())).toThrow(/removed/);
    expect(t.summary(a!.id).me).toMatchObject({ removed: true });

    // Opening the lobby lets in everyone still waiting.
    res = await hub("POST", `/api/integration/events/${ev.id}/access`, { access: "open" });
    expect(res.json().access).toBe("open");
    expect(statuses(res.json())).toEqual(["7003:registered"]);

    expect((await hub("POST", `/api/integration/events/${ev.id}/access`, { access: "ajar" })).statusCode).toBe(400);
    expect((await hub("POST", `/api/integration/events/${ev.id}/players/7002/approve`, {})).statusCode).toBe(400);
    expect((await hub("POST", `/api/integration/events/${ev.id}/players/9999999/kick`, {})).statusCode).toBe(404);
    expect((await hub("POST", `/api/integration/events/${ev.id}/players/7003/ban`, {})).statusCode).toBe(404);
  });

  it("kicks a player out of a running tournament", async () => {
    const ev = (await hub("POST", "/api/integration/events", { name: "Kick test", startTime: Date.now() + 3_600_000 })).json();
    expect(ev.access).toBe("open");
    const t = manager.get(Number(ev.id))!;
    for (const [i, d] of ["7101", "7102", "7103"].entries()) {
      const u = upsertUser(d, `kick${i}`, null);
      t.register({ id: u.id, username: u.username, avatarUrl: "" }, Date.now());
    }
    expect((await hub("POST", `/api/integration/events/${ev.id}/start`, {})).statusCode).toBe(200);
    const res = await hub("POST", `/api/integration/events/${ev.id}/players/7101/kick`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().players.find((p: { discordId: string }) => p.discordId === "7101").status).toBe("removed");
    expect((await hub("POST", `/api/integration/events/${ev.id}/players/7101/kick`, {})).statusCode).toBe(400);
    await hub("POST", `/api/integration/events/${ev.id}/cancel`, {});
  });
});
