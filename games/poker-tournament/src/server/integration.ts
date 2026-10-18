// Server-to-server API for the Event Hub, the admin dashboard that creates events on each game site
// and hands out Discord prizes to the winners. Every request in both directions is signed:
//   X-Hub-Timestamp: epoch ms        X-Hub-Signature: hex HMAC-SHA256(HUB_SECRET, `${timestamp}.${rawBody}`)
// The contract is generic ("events") so other game sites can implement the same routes.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.ts";
import { runAdminOp } from "./routes.ts";
import type { CreateOptions, TournamentManager } from "./tournament/manager.ts";
import { loadEndedMetas, loadMeta, loadResults } from "./tournament/store.ts";
import { PLAYER_CAPS, defaultConfig } from "./tournament/structure.ts";
import { TournamentError } from "./tournament/tournament.ts";
import type { TournamentMeta, TournamentStatus } from "./tournament/types.ts";

const GAME_KEY = "poker";
const MAX_SKEW_MS = 5 * 60_000;
const DEFAULT_ENDED_WINDOW_MS = 7 * 86_400_000;
const STATUSES: TournamentStatus[] = ["registering", "running", "finished", "cancelled"];
const OPS = new Set(["start", "pause", "resume", "cancel"]);

export interface EventField {
  name: string;
  label: string;
  type: "text" | "number" | "datetime" | "select";
  default?: string | number;
  min?: number;
  max?: number;
  options?: { value: string | number; label: string }[];
  help?: string;
}

export interface EventSummary {
  id: string;
  name: string;
  status: TournamentStatus;
  startTime: number;
  entrants: number;
  maxPlayers: number;
  startedAt: number | null;
  finishedAt: number | null;
  url: string;
}

export function hubSignature(secret: string, timestamp: string, rawBody: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

function signatureValid(secret: string, timestamp: unknown, signature: unknown, rawBody: string, now: number) {
  if (typeof timestamp !== "string" || typeof signature !== "string" || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_MS) return false;
  const expected = Buffer.from(hubSignature(secret, timestamp, rawBody), "hex");
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Field descriptions for the hub's "create event" form. Limits match TournamentManager.create. */
function fields(): EventField[] {
  const d = defaultConfig();
  return [
    { name: "name", label: "Name", type: "text", default: d.name, help: "Up to 60 characters." },
    { name: "startTime", label: "Start time", type: "datetime", help: "Epoch ms. Starts automatically if at least two players registered. Defaults to 30 minutes from now." },
    {
      name: "maxPlayers",
      label: "Player cap",
      type: "select",
      default: d.maxPlayers,
      options: PLAYER_CAPS.map((c) => ({ value: c, label: `${c.toLocaleString("en-US")} players` })),
      help: "6-max shootout: each cap collapses evenly to one final table.",
    },
    { name: "startingStack", label: "Starting stack", type: "number", default: d.startingStack, min: 1000, max: 1_000_000 },
    { name: "levelMinutes", label: "Level length (minutes)", type: "number", default: d.levels[0]!.minutes, min: 1, max: 60 },
    { name: "breakEveryLevels", label: "Break every N levels", type: "number", default: d.breakEveryLevels, min: 0, max: 30, help: "0 disables breaks." },
    { name: "breakMinutes", label: "Break length (minutes)", type: "number", default: d.breakMinutes, min: 0, max: 60 },
    { name: "decisionSeconds", label: "Decision time (seconds)", type: "number", default: d.decisionSeconds, min: 5, max: 120 },
    { name: "timeBankSeconds", label: "Time bank (seconds)", type: "number", default: d.timeBankSeconds, min: 0, max: 600 },
    { name: "payoutPercent", label: "Paid places (% of field)", type: "number", default: d.payoutPercent, min: 1, max: 50 },
  ];
}

function toSummary(m: TournamentMeta): EventSummary {
  return {
    id: String(m.id),
    name: m.config.name,
    status: m.status,
    startTime: m.config.startTime,
    entrants: Object.keys(m.entrants).length,
    maxPlayers: m.config.maxPlayers,
    startedAt: m.startedAt,
    finishedAt: m.finishedAt,
    url: `${config.publicUrl}/#/t/${m.id}`,
  };
}

const parseId = (id: string) => (/^\d+$/.test(id) ? Number(id) : NaN);

/**
 * onShutdown lets the hub stop this server cleanly (it starts it as a background process, and Windows
 * can't send Ctrl+C to one). Without it, the shutdown route answers 404.
 */
export function registerIntegrationRoutes(app: FastifyInstance, manager: TournamentManager, onShutdown?: () => void) {
  // Encapsulated so the raw-body JSON parser and the signature check only apply to these routes.
  app.register(async (scope) => {
    const rawBodies = new WeakMap<FastifyRequest, string>();

    scope.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
      const raw = body as string;
      rawBodies.set(req, raw);
      if (raw === "") return done(null, undefined);
      try {
        done(null, JSON.parse(raw));
      } catch {
        done(Object.assign(new Error("Invalid JSON body"), { statusCode: 400 }), undefined);
      }
    });

    scope.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
      const secret = config.hub.secret;
      if (!secret) return reply.code(503).send({ error: "integration_disabled" });
      const ok = signatureValid(secret, req.headers["x-hub-timestamp"], req.headers["x-hub-signature"], rawBodies.get(req) ?? "", Date.now());
      if (!ok) return reply.code(401).send({ error: "bad_signature" });
    });

    scope.get("/api/integration/info", async () => ({ key: GAME_KEY, name: "Poker Night", fields: fields() }));

    scope.post("/api/integration/shutdown", async (_req, reply) => {
      if (!onShutdown) return reply.code(404).send({ error: "not_supported" });
      console.log("[hub] Shutdown requested by the hub");
      // Answer first, then stop: tournaments are saved and come back paused on the next start.
      reply.raw.once("finish", () => setImmediate(onShutdown));
      return { ok: true };
    });

    scope.post<{ Body: CreateOptions | undefined }>("/api/integration/events", async (req) => {
      const t = manager.create(req.body ?? ({} as CreateOptions), Date.now());
      console.log(`[hub] Created "${t.config.name}"`);
      return toSummary(t.meta);
    });

    scope.get<{ Querystring: { status?: string; since?: string } }>("/api/integration/events", async (req, reply) => {
      const { status, since: sinceRaw } = req.query;
      if (status !== undefined && !STATUSES.includes(status as TournamentStatus)) return reply.code(400).send({ error: "bad_status" });
      const since = sinceRaw === undefined || sinceRaw === "" ? undefined : Number(sinceRaw);
      if (since !== undefined && !Number.isFinite(since)) return reply.code(400).send({ error: "bad_since" });

      // Ended tournaments leave memory after a day, so they come from the database. Memory wins for the rest.
      const byId = new Map<number, TournamentMeta>();
      for (const m of loadEndedMetas(since ?? Date.now() - DEFAULT_ENDED_WINDOW_MS)) byId.set(m.id, m);
      for (const t of manager.tournaments.values()) byId.set(t.id, t.meta);
      return [...byId.values()]
        .filter((m) => since === undefined || m.finishedAt === null || m.finishedAt >= since)
        .filter((m) => status === undefined || m.status === status)
        .sort((a, b) => a.id - b.id)
        .map(toSummary);
    });

    scope.post<{ Params: { id: string; op: string } }>("/api/integration/events/:id/:op", async (req, reply) => {
      const id = parseId(req.params.id);
      if (!OPS.has(req.params.op)) return reply.code(404).send({ error: "unknown_op" });
      const t = manager.get(id);
      if (!t) {
        // Ended tournaments that have left memory can't be changed any more.
        if (loadMeta(id)) return reply.code(400).send({ error: "The tournament is already over" });
        return reply.code(404).send({ error: "not_found" });
      }
      try {
        runAdminOp(t, req.params.op, "Event Hub", undefined, Date.now());
      } catch (err) {
        if (err instanceof TournamentError) return reply.code(400).send({ error: err.message });
        throw err;
      }
      console.log(`[hub] ${req.params.op} "${t.config.name}"`);
      return toSummary(t.meta);
    });

    scope.get<{ Params: { id: string } }>("/api/integration/events/:id/results", async (req, reply) => {
      const id = parseId(req.params.id);
      const meta = manager.get(id)?.meta ?? loadMeta(id);
      if (!meta) return reply.code(404).send({ error: "not_found" });
      return { id: String(id), status: meta.status, finishedAt: meta.finishedAt, results: loadResults(id) };
    });
  });
}

/** Tells the hub a tournament has finished. Fire-and-forget: the hub also polls, so failures only log. */
export function notifyHubEventFinished(tournamentId: number) {
  const { url, secret } = config.hub;
  if (!secret) return;
  try {
    const body = JSON.stringify({ type: "event.finished", externalId: String(tournamentId) });
    const timestamp = String(Date.now());
    fetch(`${url}/api/games/${GAME_KEY}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-timestamp": timestamp,
        "x-hub-signature": hubSignature(secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })
      .then((res) => {
        if (!res.ok) console.warn(`[hub] Webhook for tournament ${tournamentId} got HTTP ${res.status}`);
      })
      .catch((err: unknown) => console.warn(`[hub] Webhook for tournament ${tournamentId} failed:`, err instanceof Error ? err.message : err));
  } catch (err) {
    console.warn(`[hub] Webhook for tournament ${tournamentId} failed:`, err);
  }
}
