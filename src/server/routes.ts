import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GameOp, Overview, PrizeRule } from "../shared/protocol.ts";
import { AwardActionError, cancelAward, fillWaitingAwards, awardEvent, listAwards, markAwardManual, resendAward } from "./awards.ts";
import { adminFromRequest, requireAdmin } from "./auth.ts";
import type { Bot } from "./bot.ts";
import { audit, db, getSettings, recentAudit, saveSettings } from "./db.ts";
import { EventLockedError, getEvent, listEvents, setAnnounceChannel, setRules, upsertEvent } from "./events.ts";
import {
  GameInputError,
  GameRequestError,
  type LaunchInput,
  addGame,
  gameClient,
  gameSecret,
  getGame,
  getGameByKey,
  listGames,
  publicGame,
  suggestedLaunch,
  updateGame,
} from "./games.ts";
import { type ProcessManager, ServerControlError } from "./processes.ts";
import {
  PrizeInputError,
  addCodes,
  createPrize,
  deleteTemplate,
  listPrizes,
  listTemplates,
  listUnusedCodes,
  parseCodes,
  removeUnusedCodes,
  saveTemplate,
  updatePrize,
  type PrizeInput,
} from "./prizes.ts";
import { verify } from "./signing.ts";
import { syncAll, syncGame } from "./sync.ts";

const OPS = new Set<GameOp>(["start", "pause", "resume", "cancel"]);
const SNOWFLAKE = /^\d{5,25}$/;

const id = (req: FastifyRequest) => Number((req.params as { id: string }).id);

export function registerRoutes(app: FastifyInstance, bot: Bot, servers: ProcessManager) {
  // Input mistakes become a 400 with a message the dashboard shows as-is.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof PrizeInputError || err instanceof GameInputError || err instanceof EventLockedError || err instanceof AwardActionError || err instanceof ServerControlError)
      return reply.code(400).send({ error: err.message });
    if (err instanceof GameRequestError) return reply.code(err.status >= 500 || err.status === 401 ? 502 : 400).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.code(500).send({ error: "Something went wrong on the hub — see its window for details" });
  });

  // Every /api route except the game webhook is admin-only.
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    if (!path.startsWith("/api/") || path === "/api/me" || path === "/api/health" || /^\/api\/games\/[^/]+\/webhook$/.test(path)) return;
    if (!requireAdmin(req, reply)) return reply;
  });

  const actor = (req: FastifyRequest) => adminFromRequest(req)?.username ?? "admin";

  // ---------------------------------------------------------------- overview

  app.get("/api/overview", async (): Promise<Overview> => {
    const attention: Overview["attention"] = [];
    const count = (status: string) => (db.prepare(`SELECT COUNT(*) AS n FROM awards WHERE status = ?`).get(status) as { n: number }).n;
    const failed = count("dm_failed");
    if (failed) attention.push({ kind: "dm_failed", message: `${failed} prize${failed === 1 ? "" : "s"} couldn't be DM'd — winners were told to use /prizes; you can Resend.` });
    const waiting = count("waiting_stock");
    if (waiting) attention.push({ kind: "waiting_stock", message: `${waiting} winner${waiting === 1 ? " is" : "s are"} waiting for codes. Add codes and they'll be sent automatically.` });
    for (const p of listPrizes()) {
      if (p.type === "code_pool" && p.stock <= p.lowStockThreshold) attention.push({ kind: "low_stock", message: `${p.name}: ${p.stock} code${p.stock === 1 ? "" : "s"} left.` });
    }
    for (const g of listGames()) {
      const s = servers.status(g.id);
      if (s.state === "crashed") attention.push({ kind: "game_offline", message: `${g.name}'s server: ${s.message ?? "crashed"}` });
      else if (g.enabled && g.lastError && s.state !== "starting") attention.push({ kind: "game_offline", message: g.lastError });
    }
    if (!bot.ready()) attention.push({ kind: "bot_offline", message: "The Discord bot is offline, so prizes are queued, not sent. See Settings." });
    return {
      upcoming: listEvents({ status: "registering", limit: 10 }).reverse(),
      live: listEvents({ status: "running", limit: 10 }),
      recentAwards: listAwards({ limit: 10 }),
      attention,
    };
  });

  app.get("/api/audit", async () => recentAudit(200));

  // ---------------------------------------------------------------- games

  app.get("/api/games", async () => listGames().map(publicGame));

  app.post<{ Body: { key: string; name: string; baseUrl: string; secret?: string } & LaunchInput }>("/api/games", async (req) => {
    const g = addGame(req.body ?? ({} as never));
    audit(actor(req), "game added", g.name);
    void syncGame(g);
    return publicGame(g);
  });

  app.patch<{ Body: { name?: string; baseUrl?: string; enabled?: boolean; secret?: string } & LaunchInput }>("/api/games/:id", async (req) => {
    const g = updateGame(id(req), req.body ?? {});
    audit(actor(req), "game updated", g.name);
    return publicGame(g);
  });

  /** Launch settings to pre-fill when connecting a known game (Poker Night next to the hub). */
  app.get<{ Querystring: { key?: string } }>("/api/games/suggest", async (req) => suggestedLaunch(String(req.query.key ?? "")) ?? {});

  // ---------------------------------------------------------------- game servers

  app.get("/api/servers", async () => listGames().map((g) => servers.status(g.id)));

  app.get("/api/games/:id/server/logs", async (req) => ({ lines: servers.logs(id(req)) }));

  app.post<{ Params: { id: string; action: string } }>("/api/games/:id/server/:action", async (req, reply) => {
    const who = actor(req);
    switch (req.params.action) {
      case "start":
        await servers.start(id(req), who);
        break;
      case "stop":
        await servers.stop(id(req), who);
        break;
      case "restart":
        await servers.restart(id(req), who);
        break;
      default:
        return reply.code(404).send({ error: "Unknown action" });
    }
    return servers.status(id(req));
  });

  app.get("/api/games/:id/secret", async (req, reply) => {
    const secret = gameSecret(id(req));
    return secret ? { secret } : reply.code(404).send({ error: "Game not found" });
  });

  /** The game's create-event form, and a live connection check. */
  app.get("/api/games/:id/info", async (req, reply) => {
    const g = getGame(id(req));
    if (!g) return reply.code(404).send({ error: "Game not found" });
    return gameClient.info(g);
  });

  app.post("/api/sync", async () => {
    await syncAll();
    return { ok: true };
  });

  // ---------------------------------------------------------------- events

  app.get<{ Querystring: { status?: string } }>("/api/events", async (req) => listEvents({ status: req.query.status }));

  app.get("/api/events/:id", async (req, reply) => {
    const ev = getEvent(id(req));
    if (!ev) return reply.code(404).send({ error: "Event not found" });
    return { ...ev, awards: listAwards({ eventId: ev.id, limit: 1000 }) };
  });

  /** Creates the event on the game site, then attaches its prize ladder here. */
  app.post<{ Body: { gameId: number; options: Record<string, unknown>; rules?: PrizeRule[]; announceChannelId?: string } }>("/api/events", async (req, reply) => {
    const { gameId, options, rules = [], announceChannelId } = req.body ?? ({} as never);
    const g = getGame(Number(gameId));
    if (!g) return reply.code(400).send({ error: "Pick a game" });
    if (announceChannelId && !SNOWFLAKE.test(announceChannelId)) return reply.code(400).send({ error: "Pick a valid announcement channel" });
    // Check the ladder before creating anything, so a typo doesn't leave a half-made event.
    for (const r of rules) if (!(Number(r.placeFrom) >= 1)) return reply.code(400).send({ error: "Prize places start at 1" });
    const created = await gameClient.createEvent(g, options ?? {});
    const ev = upsertEvent(g.id, created);
    setRules(ev.id, rules);
    if (announceChannelId) setAnnounceChannel(ev.id, announceChannelId);
    audit(actor(req), "event created", `${g.name}: ${ev.name}`);
    return getEvent(ev.id);
  });

  app.put<{ Body: { rules: PrizeRule[] } }>("/api/events/:id/rules", async (req) => {
    setRules(id(req), req.body?.rules ?? []);
    const ev = getEvent(id(req))!;
    audit(actor(req), "prize ladder updated", ev.name);
    // An event that already finished without a ladder can still be awarded now.
    if (ev.status === "finished") void awardEvent(ev.id, actor(req)).catch(() => {});
    return ev;
  });

  app.put<{ Body: { channelId: string | null } }>("/api/events/:id/channel", async (req, reply) => {
    const channelId = req.body?.channelId || null;
    if (channelId && !SNOWFLAKE.test(channelId)) return reply.code(400).send({ error: "Pick a valid channel" });
    setAnnounceChannel(id(req), channelId);
    return getEvent(id(req));
  });

  app.post<{ Params: { id: string; op: string } }>("/api/events/:id/op/:op", async (req, reply) => {
    const ev = getEvent(id(req));
    if (!ev) return reply.code(404).send({ error: "Event not found" });
    const op = req.params.op as GameOp;
    if (!OPS.has(op)) return reply.code(404).send({ error: "Unknown operation" });
    const g = getGame(ev.gameId)!;
    const updated = await gameClient.op(g, ev.externalId, op);
    upsertEvent(g.id, updated);
    audit(actor(req), `event ${op}`, ev.name);
    if (updated.status === "finished" || updated.status === "cancelled") void syncGame(g);
    return getEvent(ev.id);
  });

  // ---------------------------------------------------------------- prizes

  app.get("/api/prizes", async () => listPrizes(true));

  app.post<{ Body: PrizeInput & { codes?: string } }>("/api/prizes", async (req) => {
    const p = createPrize(req.body ?? ({} as PrizeInput));
    if (p.type === "code_pool" && req.body?.codes) addCodes(p.id, parseCodes(req.body.codes));
    audit(actor(req), "prize created", p.name);
    return listPrizes(true).find((x) => x.id === p.id);
  });

  app.patch<{ Body: Partial<PrizeInput> & { archived?: boolean } }>("/api/prizes/:id", async (req) => {
    const p = updatePrize(id(req), req.body ?? {});
    audit(actor(req), "prize updated", p.name);
    return p;
  });

  app.post<{ Body: { text: string } }>("/api/prizes/:id/codes", async (req) => {
    const out = addCodes(id(req), parseCodes(req.body?.text ?? ""));
    const filled = fillWaitingAwards(id(req));
    audit(actor(req), "codes added", `${out.added} new to prize #${id(req)}${filled ? `, ${filled} sent to waiting winners` : ""}`);
    return { ...out, filled };
  });

  app.get("/api/prizes/:id/codes", async (req) => ({ codes: listUnusedCodes(id(req)) }));

  app.delete("/api/prizes/:id/codes", async (req) => {
    const removed = removeUnusedCodes(id(req));
    audit(actor(req), "unused codes removed", `${removed} from prize #${id(req)}`);
    return { removed };
  });

  app.get("/api/templates", async () => listTemplates());
  app.post<{ Body: { id?: number; name: string; rules: PrizeRule[] } }>("/api/templates", async (req) => saveTemplate(req.body ?? ({} as never)));
  app.delete("/api/templates/:id", async (req) => {
    deleteTemplate(id(req));
    return { ok: true };
  });

  // ---------------------------------------------------------------- awards

  app.get<{ Querystring: { status?: string; eventId?: string } }>("/api/awards", async (req) =>
    listAwards({ status: req.query.status || undefined, eventId: req.query.eventId ? Number(req.query.eventId) : undefined, limit: 500 }),
  );

  app.post<{ Params: { id: string; action: string } }>("/api/awards/:id/:action", async (req, reply) => {
    const who = actor(req);
    switch (req.params.action) {
      case "resend":
        resendAward(id(req), who);
        break;
      case "cancel":
        cancelAward(id(req), who);
        break;
      case "manual":
        markAwardManual(id(req), who);
        break;
      default:
        return reply.code(404).send({ error: "Unknown action" });
    }
    return { ok: true };
  });

  // ---------------------------------------------------------------- settings + bot

  app.get("/api/settings", async () => getSettings());

  app.put<{ Body: { guildId?: string; announceChannelId?: string; alertsChannelId?: string } }>("/api/settings", async (req, reply) => {
    const body = req.body ?? {};
    for (const v of [body.guildId, body.announceChannelId, body.alertsChannelId]) {
      if (v && !SNOWFLAKE.test(v.trim())) return reply.code(400).send({ error: "IDs are long numbers — pick from the list or paste the ID from Discord" });
    }
    saveSettings(body);
    audit(actor(req), "settings updated");
    void bot.registerCommands();
    return getSettings();
  });

  app.get("/api/bot", async () => bot.status());

  app.post<{ Body: { channelId: string } }>("/api/bot/test", async (req, reply) => {
    const channelId = req.body?.channelId;
    if (!channelId || !SNOWFLAKE.test(channelId)) return reply.code(400).send({ error: "Pick a channel" });
    try {
      await bot.post(channelId, "👋 LucidHub is plugged in. Winners get announced right here.");
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return { ok: true };
  });

  // ---------------------------------------------------------------- game webhook (signed, not a login)

  app.register(async (scope) => {
    // Signatures cover the exact bytes sent, so keep the raw body.
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    scope.post<{ Params: { key: string }; Body: string }>("/api/games/:key/webhook", async (req, reply) => {
      const g = getGameByKey(req.params.key);
      const raw = typeof req.body === "string" ? req.body : "";
      const ts = req.headers["x-hub-timestamp"];
      const sig = req.headers["x-hub-signature"];
      if (!g || !g.enabled || !verify(g.secret, raw, typeof ts === "string" ? ts : undefined, typeof sig === "string" ? sig : undefined))
        return reply.code(401).send({ error: "bad_signature" });
      // Whatever the event, a fresh sync picks it up and awards anything that ended.
      void syncGame(g);
      return { ok: true };
    });
  });
}
