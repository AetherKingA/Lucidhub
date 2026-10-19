import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameEvent, GameResults } from "../src/shared/protocol.ts";
import { buildApp } from "../src/server/app.ts";
import { startSession } from "../src/server/auth.ts";
import { awardEvent, cancelAward, createAwards, fillWaitingAwards, listAwards, prizesForUser, renderAward } from "../src/server/awards.ts";
import type { Bot } from "../src/server/bot.ts";
import { db } from "../src/server/db.ts";
import { DeliveryWorker, DmClosedError, type Messenger } from "../src/server/delivery.ts";
import { getEvent, setRules, upsertEvent } from "../src/server/events.ts";
import { addGame } from "../src/server/games.ts";
import { ProcessManager } from "../src/server/processes.ts";
import { addCodes, createPrize, getPrize, parseCodes } from "../src/server/prizes.ts";
import { sign, verify } from "../src/server/signing.ts";
import { syncGame } from "../src/server/sync.ts";

let seq = 0;
const uid = () => `${++seq}`;
/** Discord IDs are 17–20 digit numbers. */
const did = (n: number) => String(100000000000000000n + BigInt(n));

function setupEvent(status: GameEvent["status"] = "finished") {
  const game = addGame({ key: `g${uid()}`, name: "Test game", baseUrl: "http://game.test" });
  const ev = upsertEvent(game.id, { id: uid(), name: `Event ${seq}`, status, startTime: Date.now(), entrants: 10, maxPlayers: 36, startedAt: null, finishedAt: null, url: null });
  return { game, ev };
}

const results = (n: number): GameResults["results"] => Array.from({ length: n }, (_, i) => ({ discordId: did(i + 1), username: `P${i + 1}`, place: i + 1 }));

class FakeMessenger implements Messenger {
  dms: { to: string; title: string; text: string }[] = [];
  posts: { channel: string; text: string }[] = [];
  failFor = new Map<string, "closed" | "flaky">();
  ready() {
    return true;
  }
  async sendDm(to: string, m: { title: string; text: string }) {
    const f = this.failFor.get(to);
    if (f === "closed") throw new DmClosedError("Cannot send messages to this user");
    if (f === "flaky") throw new Error("Discord is having a moment");
    this.dms.push({ to, ...m });
  }
  async post(channel: string, text: string) {
    this.posts.push({ channel, text });
  }
}

// ---------------------------------------------------------------- events

describe("upsertEvent watchUrl", () => {
  it("stores http(s) links, drops other schemes, and clears when the field is missing", () => {
    const game = addGame({ key: `g${uid()}`, name: "Test game", baseUrl: "http://game.test" });
    const base: GameEvent = { id: uid(), name: "Watched", status: "running", startTime: Date.now(), entrants: 4, maxPlayers: null, startedAt: null, finishedAt: null, url: null };
    const url = "https://game.test/#/t/1/watch";
    expect(upsertEvent(game.id, { ...base, watchUrl: url }).watchUrl).toBe(url);
    expect(upsertEvent(game.id, { ...base, watchUrl: "javascript:alert(1)" }).watchUrl).toBeNull();
    upsertEvent(game.id, { ...base, watchUrl: url });
    expect(upsertEvent(game.id, base).watchUrl).toBeNull();
  });
});

// ---------------------------------------------------------------- signing

describe("signing", () => {
  it("accepts a valid signature and rejects tampering or old timestamps", () => {
    const body = JSON.stringify({ type: "event.finished", externalId: "7" });
    const h = sign("s3cret", body);
    expect(verify("s3cret", body, h["X-Hub-Timestamp"], h["X-Hub-Signature"])).toBe(true);
    expect(verify("other", body, h["X-Hub-Timestamp"], h["X-Hub-Signature"])).toBe(false);
    expect(verify("s3cret", body + " ", h["X-Hub-Timestamp"], h["X-Hub-Signature"])).toBe(false);
    expect(verify("s3cret", body, h["X-Hub-Timestamp"], undefined)).toBe(false);
    const old = sign("s3cret", body, Date.now() - 6 * 60_000);
    expect(verify("s3cret", body, old["X-Hub-Timestamp"], old["X-Hub-Signature"])).toBe(false);
  });
});

// ---------------------------------------------------------------- awarding

describe("createAwards", () => {
  it("matches places to the ladder, including ranges and stacked prizes", () => {
    const { ev } = setupEvent();
    const gold = createPrize({ name: "Gold", type: "message" });
    const key = createPrize({ name: "Key", type: "code_pool" });
    addCodes(key.id, ["K1", "K2", "K3", "K4"]);
    setRules(ev.id, [
      { placeFrom: 1, placeTo: 1, prizeId: gold.id },
      { placeFrom: 1, placeTo: 3, prizeId: key.id },
    ]);
    const out = createAwards(ev.id, results(6));
    expect(out).toEqual({ created: 4, waiting: 0, skipped: 0 });
    const awards = listAwards({ eventId: ev.id });
    expect(awards.filter((a) => a.place === 1).map((a) => a.prizeName).sort()).toEqual(["Gold", "Key"]);
    expect(awards.map((a) => a.place).sort()).toEqual([1, 1, 2, 3]);
    expect(getPrize(key.id)!.stock).toBe(1);
    expect(getEvent(ev.id)!.processedAt).not.toBeNull();
  });

  it("is idempotent: awarding the same event again creates nothing and uses no more codes", () => {
    const { ev } = setupEvent();
    const key = createPrize({ name: "Key", type: "code_pool" });
    addCodes(key.id, ["A", "B", "C"]);
    setRules(ev.id, [{ placeFrom: 1, placeTo: 2, prizeId: key.id }]);
    createAwards(ev.id, results(4));
    const again = createAwards(ev.id, results(4));
    expect(again.created).toBe(0);
    expect(listAwards({ eventId: ev.id })).toHaveLength(2);
    expect(getPrize(key.id)!.stock).toBe(1);
  });

  it("never gives the same code to two winners, across events", () => {
    const key = createPrize({ name: "Shared pool", type: "code_pool" });
    addCodes(key.id, Array.from({ length: 20 }, (_, i) => `CODE-${i}`));
    for (let i = 0; i < 4; i++) {
      const { ev } = setupEvent();
      setRules(ev.id, [{ placeFrom: 1, placeTo: 5, prizeId: key.id }]);
      createAwards(ev.id, results(5));
    }
    const codes = db.prepare(`SELECT c.code FROM awards a JOIN prize_codes c ON c.id = a.code_id WHERE a.prize_id = ?`).all(key.id) as { code: string }[];
    expect(codes).toHaveLength(20);
    expect(new Set(codes.map((c) => c.code)).size).toBe(20);
  });

  it("parks winners when a pool runs dry and serves them, oldest first, when codes are added", () => {
    const { ev } = setupEvent();
    const key = createPrize({ name: "Scarce", type: "code_pool" });
    addCodes(key.id, ["ONLY-ONE"]);
    setRules(ev.id, [{ placeFrom: 1, placeTo: 3, prizeId: key.id }]);
    const out = createAwards(ev.id, results(3));
    expect(out.waiting).toBe(2);
    const byPlace = () => Object.fromEntries(listAwards({ eventId: ev.id }).map((a) => [a.place, a.status]));
    expect(byPlace()).toEqual({ 1: "pending", 2: "waiting_stock", 3: "waiting_stock" });
    addCodes(key.id, ["NEW-1"]);
    expect(fillWaitingAwards(key.id)).toBe(1);
    expect(byPlace()).toEqual({ 1: "pending", 2: "pending", 3: "waiting_stock" });
  });

  it("skips results without a real Discord ID", () => {
    const { ev } = setupEvent();
    const p = createPrize({ name: "Msg", type: "message" });
    setRules(ev.id, [{ placeFrom: 1, placeTo: 2, prizeId: p.id }]);
    const out = createAwards(ev.id, [
      { discordId: "bot-1", username: "Bot", place: 1 },
      { discordId: did(9), username: "Human", place: 2 },
    ]);
    expect(out).toMatchObject({ created: 1, skipped: 1 });
  });

  it("returns an unsent code to the pool when its award is cancelled", () => {
    const { ev } = setupEvent();
    const key = createPrize({ name: "Refund", type: "code_pool" });
    addCodes(key.id, ["R1"]);
    setRules(ev.id, [{ placeFrom: 1, placeTo: 1, prizeId: key.id }]);
    createAwards(ev.id, results(1));
    expect(getPrize(key.id)!.stock).toBe(0);
    cancelAward(listAwards({ eventId: ev.id })[0]!.id, "test");
    expect(getPrize(key.id)!.stock).toBe(1);
  });

  it("fills message placeholders, including the code", () => {
    const { ev } = setupEvent();
    const key = createPrize({ name: "Steam key", type: "code_pool", message: "{user} got #{place} in {event}: {prize} = {code}" });
    addCodes(key.id, ["XYZ"]);
    setRules(ev.id, [{ placeFrom: 1, placeTo: 1, prizeId: key.id }]);
    createAwards(ev.id, results(1));
    const msg = renderAward(listAwards({ eventId: ev.id })[0]!.id)!;
    expect(msg.text).toBe(`<@${did(1)}> got #1 in ${ev.name}: Steam key = XYZ`);
  });
});

describe("prizes", () => {
  it("parses pasted lists and CSVs, skipping blanks and a header", () => {
    expect(parseCodes('code,note\nAAA,first\n\n "BBB" \nCCC\tx\r\n')).toEqual(["AAA", "BBB", "CCC"]);
  });
  it("requires {code} in a code-pool message", () => {
    expect(() => createPrize({ name: "Bad", type: "code_pool", message: "no code here" })).toThrow(/\{code\}/);
  });
});

// ---------------------------------------------------------------- delivery

describe("DeliveryWorker", () => {
  // The worker sends in batches, so clear what earlier tests left pending.
  beforeEach(() => void db.exec(`UPDATE awards SET status = 'cancelled' WHERE status = 'pending'`));

  it("DMs every pending award, then announces the winners without revealing codes", async () => {
    const { ev } = setupEvent();
    db.prepare(`UPDATE events SET announce_channel_id = '555555555555' WHERE id = ?`).run(ev.id);
    const key = createPrize({ name: "Gift card", type: "code_pool" });
    addCodes(key.id, ["SECRET-1", "SECRET-2"]);
    setRules(ev.id, [{ placeFrom: 1, placeTo: 2, prizeId: key.id }]);
    createAwards(ev.id, results(5));

    const m = new FakeMessenger();
    await new DeliveryWorker(m).tick();
    // Earlier tests share the database, so only look at this event's DMs.
    const mine = () => m.dms.filter((d) => d.text.includes(ev.name));
    expect(mine().map((d) => d.to).sort()).toEqual([did(1), did(2)]);
    expect(mine().find((d) => d.to === did(1))!.text).toContain("SECRET-");
    expect(listAwards({ eventId: ev.id }).every((a) => a.status === "sent")).toBe(true);

    const posts = () => m.posts.filter((x) => x.channel === "555555555555");
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.text).toContain(`🥇 <@${did(1)}> — Gift card`);
    expect(posts()[0]!.text).not.toContain("SECRET");

    // Nothing is sent or announced twice.
    await new DeliveryWorker(m).tick();
    expect(mine()).toHaveLength(2);
    expect(posts()).toHaveLength(1);
  });

  it("marks closed DMs as failed, tells the winner about /prizes, and keeps the prize there", async () => {
    const { ev } = setupEvent();
    db.prepare(`UPDATE events SET announce_channel_id = '666666666666' WHERE id = ?`).run(ev.id);
    const p = createPrize({ name: "Shirt", type: "message", message: "Reply with your size, {user}!" });
    setRules(ev.id, [{ placeFrom: 1, placeTo: 1, prizeId: p.id }]);
    createAwards(ev.id, [{ discordId: did(77), username: "Closed", place: 1 }]);

    const m = new FakeMessenger();
    m.failFor.set(did(77), "closed");
    await new DeliveryWorker(m).tick();
    const [a] = listAwards({ eventId: ev.id });
    expect(a!.status).toBe("dm_failed");
    expect(m.posts.some((x) => x.text.includes(`<@${did(77)}>`) && x.text.includes("/prizes"))).toBe(true);
    expect(prizesForUser(did(77))[0]).toMatchObject({ eventName: ev.name, status: "dm_failed" });
  });

  it("retries a temporary Discord error later instead of giving up", async () => {
    const { ev } = setupEvent();
    const p = createPrize({ name: "Retry", type: "message" });
    setRules(ev.id, [{ placeFrom: 1, placeTo: 1, prizeId: p.id }]);
    createAwards(ev.id, [{ discordId: did(88), username: "Flaky", place: 1 }]);

    const m = new FakeMessenger();
    m.failFor.set(did(88), "flaky");
    const w = new DeliveryWorker(m);
    await w.tick();
    let [a] = listAwards({ eventId: ev.id });
    expect(a).toMatchObject({ status: "pending", attempts: 1 });
    await w.tick(); // too soon: backoff
    expect(listAwards({ eventId: ev.id })[0]!.attempts).toBe(1);
    m.failFor.delete(did(88));
    await w.tick(Date.now() + 60_000);
    [a] = listAwards({ eventId: ev.id });
    expect(a!.status).toBe("sent");
  });
});

// ---------------------------------------------------------------- talking to a game

/** A fake game site that checks the hub's signatures, like a real one must. */
function fakeGame(secret: string, state: { events: GameEvent[]; results: Record<string, GameResults> }) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const headers = init?.headers as Record<string, string>;
    const body = typeof init?.body === "string" ? init.body : "";
    if (!verify(secret, body, headers["X-Hub-Timestamp"], headers["X-Hub-Signature"])) return new Response(JSON.stringify({ error: "bad_signature" }), { status: 401 });
    if (u.pathname === "/api/integration/events") return Response.json(state.events);
    const m = u.pathname.match(/^\/api\/integration\/events\/([^/]+)\/results$/);
    if (m) return Response.json(state.results[m[1]!]);
    return new Response("{}", { status: 404 });
  });
}

describe("sync with a game", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("imports events, and awards an event once it finishes", async () => {
    const game = addGame({ key: `sync${uid()}`, name: "Poker", baseUrl: "http://poker.test", secret: "shh" });
    const base: GameEvent = { id: "42", name: "Friday Poker", status: "running", startTime: Date.now(), entrants: 6, maxPlayers: 6, startedAt: Date.now(), finishedAt: null, url: null };
    const state = { events: [base], results: {} as Record<string, GameResults> };
    vi.stubGlobal("fetch", fakeGame("shh", state));

    await syncGame(game);
    const ev = db.prepare(`SELECT id FROM events WHERE game_id = ? AND external_id = '42'`).get(game.id) as { id: number };
    expect(getEvent(ev.id)!.status).toBe("running");
    const p = createPrize({ name: "Winner role msg", type: "message" });
    setRules(ev.id, [{ placeFrom: 1, placeTo: 2, prizeId: p.id }]);

    state.events = [{ ...base, status: "finished", finishedAt: Date.now() }];
    state.results["42"] = { id: "42", status: "finished", finishedAt: Date.now(), results: results(6) };
    await syncGame(game);
    expect(listAwards({ eventId: ev.id })).toHaveLength(2);
    expect(getEvent(ev.id)!.processedAt).not.toBeNull();

    // The next reconcile doesn't award it again.
    await syncGame(game);
    await awardEvent(ev.id);
    expect(listAwards({ eventId: ev.id })).toHaveLength(2);
  });

  it("records a game as offline when it rejects the hub's signature", async () => {
    const game = addGame({ key: `bad${uid()}`, name: "Wrong secret", baseUrl: "http://poker.test", secret: "mine" });
    vi.stubGlobal("fetch", fakeGame("theirs", { events: [], results: {} }));
    await syncGame(game);
    const row = db.prepare(`SELECT last_error FROM games WHERE id = ?`).get(game.id) as { last_error: string | null };
    expect(row.last_error).toMatch(/bad_signature/);
  });
});

// ---------------------------------------------------------------- HTTP

describe("HTTP API", () => {
  const fakeBot = { ready: () => false, status: async () => ({}), registerCommands: async () => {}, post: async () => {} } as unknown as Bot;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];

  beforeEach(async () => {
    ({ app } = await buildApp(fakeBot, new ProcessManager()));
  });
  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  it("keeps the dashboard API admins-only", async () => {
    expect((await app.inject({ url: "/api/overview" })).statusCode).toBe(401);
    // ADMIN_DISCORD_IDS is "100" in vitest.config.ts.
    const outsider = startSession({ discordId: "999", username: "Nope", avatar: null });
    expect((await app.inject({ url: "/api/overview", cookies: { hub_sid: outsider.token } })).statusCode).toBe(401);
    const admin = startSession({ discordId: "100", username: "Admin", avatar: null });
    const res = await app.inject({ url: "/api/overview", cookies: { hub_sid: admin.token } });
    expect(res.statusCode).toBe(200);
    expect(res.json().attention.some((a: { kind: string }) => a.kind === "bot_offline")).toBe(true);
  });

  it("accepts a signed webhook and rejects an unsigned one", async () => {
    const game = addGame({ key: `hook${uid()}`, name: "Hooked", baseUrl: "http://poker.test", secret: "whsec" });
    vi.stubGlobal("fetch", fakeGame("whsec", { events: [], results: {} }));
    const body = JSON.stringify({ type: "event.finished", externalId: "1" });
    const url = `/api/games/${game.key}/webhook`;
    const ok = await app.inject({ method: "POST", url, payload: body, headers: { "content-type": "application/json", ...sign("whsec", body) } });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({ method: "POST", url, payload: body, headers: { "content-type": "application/json", ...sign("wrong", body) } });
    expect(bad.statusCode).toBe(401);
  });

  it("shows input mistakes as readable 400s", async () => {
    const admin = startSession({ discordId: "100", username: "Admin", avatar: null });
    const res = await app.inject({ method: "POST", url: "/api/prizes", cookies: { hub_sid: admin.token }, payload: { name: "", type: "message" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/name/);
  });

  it("offers the games in games/ to the Connect a game picker", async () => {
    expect((await app.inject({ url: "/api/games/known" })).statusCode).toBe(401);
    const admin = startSession({ discordId: "100", username: "Admin", avatar: null });
    const res = await app.inject({ url: "/api/games/known", cookies: { hub_sid: admin.token } });
    expect(res.json()).toEqual(["poker", "uno", "chess"]);
  });

  it("saves, replaces and deletes your blind presets per game", async () => {
    const admin = startSession({ discordId: "100", username: "Admin", avatar: null });
    const game = addGame({ key: `blinds${uid()}`, name: "Blinds", baseUrl: "http://127.0.0.1:1" });
    const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
      app.inject({ method, url, cookies: { hub_sid: admin.token }, ...(payload ? { payload } : {}) });
    const levels = [
      { smallBlind: 10, bigBlind: 20, ante: 0, minutes: 6 },
      { smallBlind: 20, bigBlind: 40, ante: 4, minutes: 6 },
    ];
    const saved = await call("POST", `/api/games/${game.id}/blind-presets`, { name: "Friday Turbo", levels, set: { startingStack: 8000, "bad key!": 1 } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ name: "Friday Turbo", levels, set: { startingStack: 8000 }, saved: true });

    // Same name again replaces it rather than adding a second.
    await call("POST", `/api/games/${game.id}/blind-presets`, { name: "Friday Turbo", levels: [levels[0]] });
    const list = (await call("GET", `/api/games/${game.id}/blind-presets`)).json();
    expect(list).toHaveLength(1);
    expect(list[0].levels).toHaveLength(1);

    expect((await call("POST", `/api/games/${game.id}/blind-presets`, { name: "", levels })).statusCode).toBe(400);
    expect((await call("POST", `/api/games/${game.id}/blind-presets`, { name: "x", levels: [] })).statusCode).toBe(400);

    await call("DELETE", `/api/blind-presets/${list[0].id.replace("saved-", "")}`);
    expect((await call("GET", `/api/games/${game.id}/blind-presets`)).json()).toEqual([]);
  });

  it("mirrors a closed lobby and passes approvals, kicks and opening it to the game", async () => {
    const game = addGame({ key: `lobby${uid()}`, name: "Lobby game", baseUrl: "http://lobby.test", secret: "lsec" });
    const ev: GameEvent = { id: "5", name: "Invite only", status: "registering", startTime: Date.now(), entrants: 0, maxPlayers: 8, startedAt: null, finishedAt: null, url: null, access: "closed", pending: 1 };
    const lobby = { access: "closed", players: [{ discordId: did(1), username: "Ann", avatarUrl: "", status: "pending", place: null }] };
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = new URL(String(url));
        const headers = init?.headers as Record<string, string>;
        const body = typeof init?.body === "string" ? init.body : "";
        if (!verify("lsec", body, headers["X-Hub-Timestamp"], headers["X-Hub-Signature"])) return new Response("{}", { status: 401 });
        calls.push(`${init?.method} ${u.pathname} ${body}`);
        return Response.json(u.pathname === "/api/integration/events" ? [ev] : lobby);
      }),
    );
    await syncGame(game);
    const { id } = db.prepare(`SELECT id FROM events WHERE game_id = ? AND external_id = '5'`).get(game.id) as { id: number };
    expect(getEvent(id)).toMatchObject({ access: "closed", pending: 1 });

    const admin = startSession({ discordId: "100", username: "Admin", avatar: null });
    const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, payload, cookies: { hub_sid: admin.token } });
    expect((await call("GET", `/api/events/${id}/players`)).json()).toEqual({ ...lobby, locations: false });
    expect((await call("POST", `/api/events/${id}/players/${did(1)}/approve`, {})).statusCode).toBe(200);
    expect((await call("POST", `/api/events/${id}/players/${did(1)}/kick`, {})).statusCode).toBe(200);
    expect((await call("PUT", `/api/events/${id}/access`, { access: "open" })).statusCode).toBe(200);
    expect(calls).toContain(`POST /api/integration/events/5/players/${did(1)}/approve {}`);
    expect(calls).toContain(`POST /api/integration/events/5/players/${did(1)}/kick {}`);
    expect(calls).toContain(`POST /api/integration/events/5/access {"access":"open"}`);
    expect((await call("POST", `/api/events/${id}/players/${did(1)}/ban`, {})).statusCode).toBe(404);
    expect((await call("PUT", `/api/events/${id}/access`, { access: "ajar" })).statusCode).toBe(400);
  });
});
