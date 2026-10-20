import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Config reads the environment on import, so point it at a throwaway database before loading the server.
const SECRET = "test-secret";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "flappy-integration-")), "test.db");
process.env.HUB_SECRET = SECRET;
process.env.HUB_URL = "http://hub.test/";
process.env.PUBLIC_URL = "https://flappy.example";

const { default: Fastify } = await import("fastify");
const { db, upsertUser } = await import("../src/server/db.ts");
const { hubSignature, registerIntegrationRoutes } = await import("../src/server/integration.ts");
const { TournamentManager } = await import("../src/server/tournament/manager.ts");

vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));

const manager = new TournamentManager({ isConnected: () => false, lobbyChanged: () => {}, tournamentChanged: () => {} });
const app = Fastify();
registerIntegrationRoutes(app, manager, vi.fn());

beforeAll(() => app.ready());
afterAll(async () => {
  manager.stop();
  await app.close();
  db.close();
});

function hub(method: "GET" | "POST", url: string, body?: unknown, opts: { secret?: string } = {}) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Date.now());
  return app.inject({
    method,
    url,
    payload: raw || undefined,
    headers: {
      ...(raw ? { "content-type": "application/json" } : {}),
      "x-hub-timestamp": timestamp,
      "x-hub-signature": hubSignature(opts.secret ?? SECRET, timestamp, raw),
    },
  });
}

describe("hub contract", () => {
  it("rejects a bad signature", async () => {
    expect((await hub("GET", "/api/integration/info", undefined, { secret: "nope" })).statusCode).toBe(401);
  });

  it("describes the game, including the time limit", async () => {
    const info = (await hub("GET", "/api/integration/info")).json();
    expect(info).toMatchObject({ key: "flappy", name: "Flappy Night" });
    expect(info.fields.map((f: { name: string }) => f.name)).toEqual(["name", "startTime", "durationMinutes", "access", "maxPlayers"]);
  });

  it("creates, runs and finishes an event, sending results only after the finale", async () => {
    const created = (await hub("POST", "/api/integration/events", { name: "Friday Flaps", startTime: Date.now() + 3_600_000, durationMinutes: 99 })).json();
    expect(created).toMatchObject({ name: "Friday Flaps", status: "registering", url: `https://flappy.example/#/t/${created.id}` });
    const t = manager.get(Number(created.id))!;
    expect(t.config.durationMinutes).toBe(30); // clamped

    const a = upsertUser("900000000000000001", "Ada", null);
    const b = upsertUser("900000000000000002", "Bo", null);
    t.register({ id: a.id, username: "Ada", avatarUrl: "" }, Date.now());
    t.register({ id: b.id, username: "Bo", avatarUrl: "" }, Date.now());

    const started = (await hub("POST", `/api/integration/events/${created.id}/start`)).json();
    expect(started).toMatchObject({ status: "running", watchUrl: `https://flappy.example/#/t/${created.id}/watch` });

    const now = Date.now();
    t.startRun(a.id, now);
    t.endRun(a.id, [], now + 2000);
    t.tick(t.meta.endsAt! + 5000);
    expect(t.meta.status).toBe("finale");
    // The hub sees the finale as still running, and no places yet.
    const during = (await hub("GET", `/api/integration/events?since=0`)).json();
    expect(during.find((e: { id: string }) => e.id === created.id).status).toBe("running");
    const lobby = (await hub("GET", `/api/integration/events/${created.id}/players`)).json();
    expect(lobby.players.every((p: { place: number | null }) => p.place === null)).toBe(true);

    t.tick(t.meta.finale!.endsAt);
    const results = (await hub("GET", `/api/integration/events/${created.id}/results`)).json();
    expect(results).toMatchObject({
      status: "finished",
      results: [
        { discordId: "900000000000000001", username: "Ada", place: 1 },
        { discordId: "900000000000000002", username: "Bo", place: 2 },
      ],
    });
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith("/api/games/flappy/webhook") && String(init?.body).includes("event.finished"))).toBe(true);
  });

  it("closed lobby: players ask to join and the admin lets them in, even after the start", async () => {
    const created = (await hub("POST", "/api/integration/events", { name: "Closed", startTime: Date.now() + 3_600_000, access: "closed" })).json();
    const t = manager.get(Number(created.id))!;
    const users = [1, 2, 3].map((i) => upsertUser(`91000000000000000${i}`, `U${i}`, null));
    for (const u of users) t.register({ id: u.id, username: u.username, avatarUrl: "" }, Date.now());
    expect(Object.keys(t.meta.entrants)).toHaveLength(0);
    for (const u of users.slice(0, 2)) await hub("POST", `/api/integration/events/${created.id}/players/${u.discordId}/approve`);
    await hub("POST", `/api/integration/events/${created.id}/start`);
    const res = (await hub("POST", `/api/integration/events/${created.id}/players/${users[2]!.discordId}/approve`)).json();
    expect(res.players.filter((p: { status: string }) => p.status === "playing")).toHaveLength(3);
  });
});
