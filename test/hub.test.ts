import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameEvent, GameResults } from "../src/shared/protocol.ts";
import { buildApp } from "../src/server/app.ts";
import { startSession } from "../src/server/auth.ts";
import { awardEvent, cancelAward, createAwards, fillWaitingAwards, listAwards, prizesForUser, renderAward } from "../src/server/awards.ts";
import type { Bot } from "../src/server/bot.ts";
import { db } from "../src/server/db.ts";
import { DeliveryWorker, DmClosedError, type Messenger } from "../src/server/delivery.ts";
import { getEvent, listEvents, setRules, upsertEvent } from "../src/server/events.ts";
import { addGame } from "../src/server/games.ts";
import { geoipAvailable } from "../src/server/geoip.ts";
import { ProcessManager } from "../src/server/processes.ts";
import { addCodes, createPrize, getPrize, listPrizes, parseCodes, updatePrize } from "../src/server/prizes.ts";
import { prizeName } from "../src/shared/prizeKinds.ts";
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

describe("listEvents", () => {
  it("lists upcoming events soonest first, so a limit keeps the next ones", () => {
    const game = addGame({ key: `g${uid()}`, name: "Test game", baseUrl: "http://game.test" });
    const day = 86_400_000;
    for (const [name, inDays] of [["Later", 3], ["Tomorrow", 1], ["Next week", 7]] as const)
      upsertEvent(game.id, { id: uid(), name, status: "registering", startTime: Date.now() + inDays * day, entrants: 0, maxPlayers: 8, startedAt: null, finishedAt: null, url: null });
    const mine = listEvents({ status: "registering" }).filter((e) => e.gameId === game.id);
    expect(mine.map((e) => e.name)).toEqual(["Tomorrow", "Later", "Next week"]);
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

  it("gives each place its own Lucid prize: 1st a 50K account, 2nd a 25K account, 3rd Lupees", () => {
    const { ev } = setupEvent();
    const big = createPrize({ name: "", type: "code_pool", kind: "account", amount: 50_000 });
    const small = createPrize({ name: "", type: "code_pool", kind: "account", amount: 25_000 });
    const lupees = createPrize({ name: "", type: "code_pool", kind: "lupees", amount: 1_000 });
    addCodes(big.id, ["ACC50-1", "ACC50-2"]);
    addCodes(small.id, ["ACC25-1", "ACC25-2"]);
    addCodes(lupees.id, ["LUP-1", "LUP-2"]);
    setRules(ev.id, [
      { placeFrom: 1, placeTo: 1, prizeId: big.id },
      { placeFrom: 2, placeTo: 2, prizeId: small.id },
      { placeFrom: 3, placeTo: 3, prizeId: lupees.id },
    ]);
    expect(createAwards(ev.id, results(5))).toEqual({ created: 3, waiting: 0, skipped: 0 });
    const byPlace = new Map(listAwards({ eventId: ev.id }).map((a) => [a.place, renderAward(a.id)!]));
    expect(byPlace.get(1)!.prizeName).toBe("50K Account");
    expect(byPlace.get(1)!.text).toContain("ACC50-1");
    expect(byPlace.get(2)!.prizeName).toBe("25K Account");
    expect(byPlace.get(2)!.text).toContain("ACC25-1");
    expect(byPlace.get(3)!.prizeName).toBe("1,000 Lupees");
    expect(byPlace.get(3)!.text).toContain("LUP-1");
    expect([big, small, lupees].map((p) => getPrize(p.id)!.stock)).toEqual([1, 1, 1]);
  });
});

describe("prizes", () => {
  it("parses pasted lists and CSVs, skipping blanks and a header", () => {
    expect(parseCodes('code,note\nAAA,first\n\n "BBB" \nCCC\tx\r\n')).toEqual(["AAA", "BBB", "CCC"]);
  });
  it("requires {code} in a code-pool message", () => {
    expect(() => createPrize({ name: "Bad", type: "code_pool", message: "no code here" })).toThrow(/\{code\}/);
  });
  it("names account and Lupees prizes from their amount, and always hands them out as codes", () => {
    const acc = createPrize({ name: " ", type: "message", kind: "account", amount: 50_000 });
    expect(acc).toMatchObject({ name: "50K Account", type: "code_pool", kind: "account", amount: 50_000 });
    expect(acc.message).toContain("{code}");
    expect(createPrize({ name: "", type: "code_pool", kind: "lupees", amount: 1_000 }).name).toBe("1,000 Lupees");
    expect(createPrize({ name: "Grand prize", type: "code_pool", kind: "account", amount: 100_000 }).name).toBe("Grand prize");
    expect([prizeName("account", 2_500), prizeName("account", 1_500_000), prizeName("lupees", 1)]).toEqual(["2.5K Account", "1.5M Account", "1 Lupee"]);
  });
  it("needs an amount for accounts and Lupees, and keeps a prize's kind fixed", () => {
    expect(() => createPrize({ name: "", type: "code_pool", kind: "account" })).toThrow(/account size/);
    expect(() => createPrize({ name: "", type: "code_pool", kind: "lupees", amount: 0 })).toThrow(/Lupees/);
    expect(() => createPrize({ name: "", type: "code_pool", kind: "lupees", amount: 2.5 })).toThrow(/Lupees/);
    const acc = createPrize({ name: "", type: "code_pool", kind: "account", amount: 10_000 });
    const edited = updatePrize(acc.id, { kind: "custom", amount: 15_000, name: "15K Account" });
    expect(edited).toMatchObject({ kind: "account", amount: 15_000, name: "15K Account" });
    const old = createPrize({ name: "Steam key", type: "code_pool" });
    expect(old).toMatchObject({ kind: "custom", amount: null });
  });
  it("lists accounts first, then Lupees, then other prizes, biggest first", () => {
    const made = [
      createPrize({ name: "Zz sticker", type: "message" }),
      createPrize({ name: "", type: "code_pool", kind: "lupees", amount: 500 }),
      createPrize({ name: "", type: "code_pool", kind: "account", amount: 25_000 }),
      createPrize({ name: "", type: "code_pool", kind: "lupees", amount: 5_000 }),
      createPrize({ name: "", type: "code_pool", kind: "account", amount: 200_000 }),
    ].map((p) => p.id);
    const order = listPrizes().filter((p) => made.includes(p.id)).map((p) => p.name);
    expect(order).toEqual(["200K Account", "25K Account", "5,000 Lupees", "500 Lupees", "Zz sticker"]);
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

  it("skips a prize that was cancelled while the batch was being sent", async () => {
    const { ev } = setupEvent();
    const key = createPrize({ name: "Cancel me", type: "code_pool" });
    addCodes(key.id, ["C-1", "C-2"]);
    setRules(ev.id, [{ placeFrom: 1, placeTo: 2, prizeId: key.id }]);
    createAwards(ev.id, results(2));
    const second = listAwards({ eventId: ev.id }).find((a) => a.place === 2)!;

    const m = new FakeMessenger();
    const send = m.sendDm.bind(m);
    m.sendDm = async (to, msg) => {
      if (to === did(1)) cancelAward(second.id, "test"); // the admin clicks Cancel mid-batch
      return send(to, msg);
    };
    await new DeliveryWorker(m).tick();
    expect(m.dms.filter((d) => d.text.includes(ev.name)).map((d) => d.to)).toEqual([did(1)]);
    expect(listAwards({ eventId: ev.id }).find((a) => a.id === second.id)!.status).toBe("cancelled");
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

  it("creates a Lucid account prize with its codes", async () => {
    const admin = startSession({ discordId: "100", username: "Admin", avatar: null });
    const payload = { name: "", type: "code_pool", kind: "account", amount: 50_000, codes: "A50-1\nA50-2" };
    const res = await app.inject({ method: "POST", url: "/api/prizes", cookies: { hub_sid: admin.token }, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "50K Account", kind: "account", amount: 50_000, stock: 2 });
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
    // `locations` says whether data/geoip/ holds lookup files on this PC, so it differs per machine.
    expect((await call("GET", `/api/events/${id}/players`)).json()).toEqual({ ...lobby, locations: geoipAvailable() });
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
