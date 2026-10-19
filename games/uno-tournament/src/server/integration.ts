// Server-to-server API for the Event Hub, the admin dashboard that creates events on each game site
// and hands out Discord prizes to the winners. Every request in both directions is signed:
//   X-Hub-Timestamp: epoch ms        X-Hub-Signature: hex HMAC-SHA256(HUB_SECRET, `${timestamp}.${rawBody}`)
// The contract is generic ("events") so other game sites can implement the same routes.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.ts";
import { type PlayerRecord, discordIdOf, findUserByDiscordId, playerRecord } from "./db.ts";
import { runAdminOp } from "./routes.ts";
import type { CreateOptions, TournamentManager } from "./tournament/manager.ts";
import { loadEndedMetas, loadMeta, loadResults } from "./tournament/store.ts";
import { MAX_PLAYERS, TABLE_SIZES, WINS_TO_ADVANCE, defaultConfig } from "./tournament/structure.ts";
import { type Tournament, TournamentError } from "./tournament/tournament.ts";
import type { TournamentMeta, TournamentStatus, LobbyAccess } from "./tournament/types.ts";

const GAME_KEY = "uno";
const MAX_SKEW_MS = 5 * 60_000;
const DEFAULT_ENDED_WINDOW_MS = 7 * 86_400_000;
const STATUSES: TournamentStatus[] = ["registering", "running", "finished", "cancelled"];
const OPS = new Set(["start", "pause", "resume", "cancel"]);
const PLAYER_ACTIONS = new Set(["approve", "deny", "kick"]);

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
  access: LobbyAccess;
  /** Join requests waiting for an admin. */
  pending: number;
  maxPlayers: number;
  startedAt: number | null;
  finishedAt: number | null;
  url: string;
  /** Where people can watch it live. Only while it's running. */
  watchUrl: string | null;
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
    { name: "startTime", label: "Start time", type: "datetime", help: "It starts by itself at this time if at least two players have registered." },
    {
      name: "access",
      label: "Lobby",
      type: "select",
      default: "open",
      options: [
        { value: "open", label: "Open: anyone can join" },
        { value: "closed", label: "Closed: you approve each player" },
      ],
      help: "Closed: players ask to join, and you let them in from the event's page in LucidHub.",
    },
    { name: "maxPlayers", label: "Player cap", type: "number", default: d.maxPlayers, min: 2, max: MAX_PLAYERS },
    {
      name: "tableSize",
      label: "Players per table",
      type: "select",
      default: d.tableSize,
      options: TABLE_SIZES.map((n) => ({ value: n, label: `${n} players` })),
      help: "Each table's winner goes through; the winners of that many tables meet at a new table in the next round.",
    },
    {
      name: "winsToAdvance",
      label: "Hands to win a table",
      type: "select",
      default: d.winsToAdvance,
      options: WINS_TO_ADVANCE.map((n) => ({ value: n, label: n === 1 ? "1 hand (fast)" : `First to ${n} hands` })),
      help: "The first player to win this many hands at a table wins the table.",
    },
    {
      name: "stacking",
      label: "Stacking +2 / +4",
      type: "select",
      default: d.stacking ? "on" : "off",
      options: [
        { value: "off", label: "Off (official rules)" },
        { value: "on", label: "On" },
      ],
      help: "On: a player hit by Draw Two or Wild Draw Four can pass it on with another draw card; whoever finally draws takes the total.",
    },
    { name: "decisionSeconds", label: "Decision time (seconds)", type: "number", default: d.decisionSeconds, min: 5, max: 60 },
    { name: "timeBankSeconds", label: "Time bank (seconds)", type: "number", default: d.timeBankSeconds, min: 0, max: 300, help: "Extra thinking time per table, used once the decision time runs out." },
  ];
}

function toSummary(m: TournamentMeta): EventSummary {
  return {
    id: String(m.id),
    name: m.config.name,
    status: m.status,
    startTime: m.config.startTime,
    entrants: Object.keys(m.entrants).length,
    access: m.access ?? "open",
    pending: m.status === "registering" ? Object.keys(m.pending ?? {}).length : 0,
    maxPlayers: m.config.maxPlayers,
    startedAt: m.startedAt,
    finishedAt: m.finishedAt,
    url: `${config.publicUrl}/#/t/${m.id}`,
    watchUrl: m.status === "running" ? `${config.publicUrl}/#/t/${m.id}/watch` : null,
  };
}

const parseId = (id: string) => (/^\d+$/.test(id) ? Number(id) : NaN);

export interface EventPlayer {
  discordId: string;
  username: string;
  avatarUrl: string;
  status: "pending" | "registered" | "playing" | "waiting" | "out" | "removed";
  place: number | null;
  /** When they registered, or asked to join. */
  joinedAt: number;
  online: boolean;
  record: PlayerRecord;
}

const STATUS_ORDER: EventPlayer["status"][] = ["pending", "playing", "waiting", "registered", "out", "removed"];

/** Everyone in a tournament, plus (before the start) everyone asking to join. For the hub's lobby panel. */
function playerList(m: TournamentMeta, manager: TournamentManager): EventPlayer[] {
  const kicked = new Set(m.kicked ?? []);
  const pending: EventPlayer[] =
    m.status === "registering"
      ? Object.values(m.pending ?? {}).map((p) => ({
          discordId: discordIdOf(p.userId) ?? "",
          username: p.username,
          avatarUrl: p.avatarUrl,
          status: "pending",
          place: null,
          joinedAt: p.requestedAt,
          online: manager.isOnline(p.userId),
          record: playerRecord(p.userId),
        }))
      : [];
  const entrants = Object.values(m.entrants).map(
    (e): EventPlayer => ({
      discordId: discordIdOf(e.userId) ?? "",
      username: e.username,
      avatarUrl: e.avatarUrl,
      status: kicked.has(e.userId)
        ? "removed"
        : e.place !== null
          ? "out"
          : m.status === "registering"
            ? "registered"
            : e.tableId !== null
              ? "playing"
              : e.advancedTo !== null
                ? "waiting"
                : "out",
      place: e.place,
      joinedAt: e.registeredAt,
      online: manager.isOnline(e.userId),
      record: playerRecord(e.userId),
    }),
  );
  return [...pending, ...entrants].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || (a.place ?? 0) - (b.place ?? 0) || a.username.localeCompare(b.username),
  );
}

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

    scope.get("/api/integration/info", async () => ({ key: GAME_KEY, name: "Uno Night", fields: fields() }));

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

    /** Runs an admin change on a live tournament, then answers with its lobby. */
    const changeLobby = (rawId: string, reply: FastifyReply, what: string, change: (t: Tournament, now: number) => void) => {
      const id = parseId(rawId);
      const t = manager.get(id);
      if (!t) return loadMeta(id) ? reply.code(400).send({ error: "The tournament is already over" }) : reply.code(404).send({ error: "not_found" });
      try {
        change(t, Date.now());
      } catch (err) {
        if (err instanceof TournamentError) return reply.code(400).send({ error: err.message });
        throw err;
      }
      console.log(`[hub] ${what} in "${t.config.name}"`);
      return { access: t.access, players: playerList(t.meta, manager) };
    };

    scope.get<{ Params: { id: string } }>("/api/integration/events/:id/players", async (req, reply) => {
      const id = parseId(req.params.id);
      const meta = manager.get(id)?.meta ?? loadMeta(id);
      if (!meta) return reply.code(404).send({ error: "not_found" });
      return { access: meta.access ?? "open", players: playerList(meta, manager) };
    });

    scope.post<{ Params: { id: string }; Body: { access?: string } | undefined }>("/api/integration/events/:id/access", async (req, reply) => {
      const access = req.body?.access;
      if (access !== "open" && access !== "closed") return reply.code(400).send({ error: "The lobby must be open or closed" });
      return changeLobby(req.params.id, reply, `Lobby ${access}`, (t, now) => t.setAccess(access, now));
    });

    scope.post<{ Params: { id: string; discordId: string; action: string } }>("/api/integration/events/:id/players/:discordId/:action", async (req, reply) => {
      const { action, discordId } = req.params;
      if (!PLAYER_ACTIONS.has(action)) return reply.code(404).send({ error: "unknown_action" });
      const user = findUserByDiscordId(discordId);
      if (!user) return reply.code(404).send({ error: "That player isn't in this tournament" });
      return changeLobby(req.params.id, reply, `${action} ${user.username}`, (t, now) => {
        if (action === "approve") t.approve(user.id, now);
        else if (action === "deny") t.deny(user.id);
        else t.kick(user.id, now);
      });
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
  postToHub("event.finished", tournamentId);
}

const changeTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** Tells the hub a tournament's players or status changed, so its dashboard stays live. At most once a second per tournament. */
export function notifyHubEventChanged(tournamentId: number) {
  if (!config.hub.secret || changeTimers.has(tournamentId)) return;
  const timer = setTimeout(() => {
    changeTimers.delete(tournamentId);
    postToHub("event.updated", tournamentId);
  }, 1000);
  timer.unref?.();
  changeTimers.set(tournamentId, timer);
}

function postToHub(type: "event.finished" | "event.updated", tournamentId: number) {
  const { url, secret } = config.hub;
  if (!secret) return;
  try {
    const body = JSON.stringify({ type, externalId: String(tournamentId) });
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
        if (!res.ok) console.warn(`[hub] ${type} webhook for tournament ${tournamentId} got HTTP ${res.status}`);
      })
      .catch((err: unknown) => console.warn(`[hub] ${type} webhook for tournament ${tournamentId} failed:`, err instanceof Error ? err.message : err));
  } catch (err) {
    console.warn(`[hub] ${type} webhook for tournament ${tournamentId} failed:`, err);
  }
}
