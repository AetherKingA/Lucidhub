// Connected game sites and the signed client the hub uses to talk to them (INTEGRATION.md).

import { randomBytes } from "node:crypto";
import type { GameEvent, GameInfo, GameOp, GameResults, GameRow } from "../shared/protocol.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { sign } from "./signing.ts";

export interface Game {
  id: number;
  key: string;
  name: string;
  baseUrl: string;
  secret: string;
  enabled: boolean;
  lastOkAt: number | null;
  lastError: string | null;
}

type GameDbRow = {
  id: number;
  key: string;
  name: string;
  base_url: string;
  secret: string;
  enabled: number;
  last_ok_at: number | null;
  last_error: string | null;
};

const toGame = (r: GameDbRow): Game => ({
  id: r.id,
  key: r.key,
  name: r.name,
  baseUrl: r.base_url,
  secret: r.secret,
  enabled: r.enabled === 1,
  lastOkAt: r.last_ok_at,
  lastError: r.last_error,
});

export const webhookUrl = (key: string) => `http://127.0.0.1:${config.port}/api/games/${key}/webhook`;

export function publicGame(g: Game): GameRow {
  return {
    id: g.id,
    key: g.key,
    name: g.name,
    baseUrl: g.baseUrl,
    enabled: g.enabled,
    lastOkAt: g.lastOkAt,
    lastError: g.lastError,
    webhookUrl: webhookUrl(g.key),
  };
}

export function listGames(): Game[] {
  return (db.prepare(`SELECT * FROM games ORDER BY id`).all() as GameDbRow[]).map(toGame);
}

export function getGame(id: number): Game | null {
  const r = db.prepare(`SELECT * FROM games WHERE id = ?`).get(id) as GameDbRow | undefined;
  return r ? toGame(r) : null;
}

export function getGameByKey(key: string): Game | null {
  const r = db.prepare(`SELECT * FROM games WHERE key = ?`).get(key) as GameDbRow | undefined;
  return r ? toGame(r) : null;
}

export class GameInputError extends Error {}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

export function addGame(input: { key: string; name: string; baseUrl: string; secret?: string }): Game {
  const key = String(input.key ?? "").trim().toLowerCase();
  if (!KEY_RE.test(key)) throw new GameInputError("Key must be lowercase letters, numbers or dashes, e.g. poker");
  if (getGameByKey(key)) throw new GameInputError(`A game with key "${key}" already exists`);
  const baseUrl = normalizeUrl(input.baseUrl);
  const secret = input.secret?.trim() || randomBytes(32).toString("hex");
  const name = String(input.name ?? "").trim().slice(0, 60) || key;
  const r = db
    .prepare(`INSERT INTO games (key, name, base_url, secret, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *`)
    .get(key, name, baseUrl, secret, Date.now()) as GameDbRow;
  return toGame(r);
}

export function updateGame(id: number, patch: { name?: string; baseUrl?: string; enabled?: boolean; secret?: string }) {
  const g = getGame(id);
  if (!g) throw new GameInputError("Game not found");
  db.prepare(`UPDATE games SET name = ?, base_url = ?, enabled = ?, secret = ? WHERE id = ?`).run(
    patch.name?.trim().slice(0, 60) || g.name,
    patch.baseUrl !== undefined ? normalizeUrl(patch.baseUrl) : g.baseUrl,
    patch.enabled === undefined ? Number(g.enabled) : Number(patch.enabled),
    patch.secret?.trim() || g.secret,
    id,
  );
  return getGame(id)!;
}

/** Reveals a game's shared secret, for pasting into that game's .env. */
export function gameSecret(id: number) {
  return getGame(id)?.secret ?? null;
}

function normalizeUrl(url: string) {
  const u = String(url ?? "").trim().replace(/\/$/, "");
  if (!/^https?:\/\/[^\s]+$/.test(u)) throw new GameInputError("Address must start with http:// or https://");
  return u;
}

/** Remembers whether the game answered, so the dashboard can show it as online or offline. */
export function recordHealth(id: number, error: string | null) {
  if (error) db.prepare(`UPDATE games SET last_error = ? WHERE id = ?`).run(error, id);
  else db.prepare(`UPDATE games SET last_ok_at = ?, last_error = NULL WHERE id = ?`).run(Date.now(), id);
}

// ---------------------------------------------------------------- client

export class GameRequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const TIMEOUT_MS = 10_000;

async function call<T>(game: Game, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  let res: Response;
  try {
    res = await fetch(`${game.baseUrl}${path}`, {
      method,
      headers: { ...sign(game.secret, raw), ...(raw ? { "Content-Type": "application/json" } : {}) },
      body: raw || undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const msg = `${game.name} is not reachable at ${game.baseUrl} (${(err as Error).message})`;
    recordHealth(game.id, msg);
    throw new GameRequestError(msg, 502);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const reason = (data as { error?: string } | null)?.error ?? (text.slice(0, 200) || res.statusText);
    // A 4xx about the request itself (bad input, wrong state) still means the game is up.
    if (res.status === 401 || res.status === 503 || res.status >= 500) recordHealth(game.id, `${game.name}: ${reason} (HTTP ${res.status})`);
    else recordHealth(game.id, null);
    throw new GameRequestError(reason, res.status);
  }
  recordHealth(game.id, null);
  return data as T;
}

export const gameClient = {
  info: (g: Game) => call<GameInfo>(g, "GET", "/api/integration/info"),
  listEvents: (g: Game, since: number) => call<GameEvent[]>(g, "GET", `/api/integration/events?since=${since}`),
  createEvent: (g: Game, options: Record<string, unknown>) => call<GameEvent>(g, "POST", "/api/integration/events", options),
  op: (g: Game, externalId: string, op: GameOp) =>
    call<GameEvent>(g, "POST", `/api/integration/events/${encodeURIComponent(externalId)}/${op}`, {}),
  results: (g: Game, externalId: string) =>
    call<GameResults>(g, "GET", `/api/integration/events/${encodeURIComponent(externalId)}/results`),
};
