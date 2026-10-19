// Connected game sites and the signed client the hub uses to talk to them (INTEGRATION.md).

import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { GameEvent, GameInfo, GameOp, GameResults, GameRow } from "../shared/protocol.ts";
import { ROOT, config } from "./config.ts";
import { db } from "./db.ts";
import { sign } from "./signing.ts";
import { FUNNEL_PORTS } from "./tailscale.ts";

export interface Game {
  id: number;
  key: string;
  name: string;
  baseUrl: string;
  secret: string;
  enabled: boolean;
  lastOkAt: number | null;
  lastError: string | null;
  /** Folder the game server runs in, and the command that starts it. Null = the hub doesn't run it. */
  launchDir: string | null;
  launchCmd: string | null;
  /** Start the game server whenever the hub starts (and restart it if it crashes). */
  autostart: boolean;
  /** Open the game to players on the internet with Tailscale Funnel while it runs. */
  publicAccess: boolean;
  /** Which public HTTPS port the Funnel uses (443, 8443 or 10000): one game per port. */
  funnelPort: number;
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
  launch_dir: string | null;
  launch_cmd: string | null;
  autostart: number;
  public_access: number;
  funnel_port: number;
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
  launchDir: r.launch_dir,
  launchCmd: r.launch_cmd,
  autostart: r.autostart === 1,
  publicAccess: r.public_access === 1,
  funnelPort: r.funnel_port,
});

/** The port a game listens on, from its address (http://127.0.0.1:3000 → 3000). */
export function localPort(g: Game): number {
  const u = new URL(g.baseUrl);
  return Number(u.port) || (u.protocol === "https:" ? 443 : 80);
}

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
    launchDir: g.launchDir,
    launchCmd: g.launchCmd,
    autostart: g.autostart,
    publicAccess: g.publicAccess,
    funnelPort: g.funnelPort,
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

export interface LaunchInput {
  launchDir?: string | null;
  launchCmd?: string | null;
  autostart?: boolean;
  publicAccess?: boolean;
  funnelPort?: number;
}

/** Games that live in games/ inside the hub folder, so the dashboard can fill in their settings. Each gets its own port and public port. */
const KNOWN_GAMES: Record<string, { folder: string; name: string; baseUrl: string; funnelPort: number }> = {
  poker: { folder: "games/poker-tournament", name: "Poker Night", baseUrl: "http://127.0.0.1:3000", funnelPort: 443 },
  uno: { folder: "games/uno-tournament", name: "Uno Night", baseUrl: "http://127.0.0.1:3001", funnelPort: 8443 },
  chess: { folder: "games/chess-tournament", name: "Chess Night", baseUrl: "http://127.0.0.1:3002", funnelPort: 10000 },
};

export function suggestedLaunch(
  key: string,
): { name: string; baseUrl: string; launchDir: string; launchCmd: string; publicAccess: boolean; funnelPort: number } | null {
  const known = Object.hasOwn(KNOWN_GAMES, key) ? KNOWN_GAMES[key]! : null;
  if (!known) return null;
  const dir = resolve(ROOT, known.folder);
  if (!existsSync(resolve(dir, "package.json"))) return null;
  // "npm start" builds the site, then runs the server. Players reach it over the internet.
  return { name: known.name, baseUrl: known.baseUrl, launchDir: dir, launchCmd: "npm start", publicAccess: true, funnelPort: known.funnelPort };
}

/** cmd.exe reads "scripts/hub-start.cmd" as a program "scripts" with a switch, so use backslashes in the program path. */
export function windowsProgramPath(cmd: string | null, platform = process.platform) {
  if (!cmd || platform !== "win32") return cmd;
  const m = cmd.match(/^("[^"]*"|\S+)(.*)$/s);
  if (!m || m[1]!.includes("://")) return cmd;
  return m[1]!.replace(/\//g, "\\") + m[2];
}

function cleanLaunch(input: LaunchInput) {
  const launchDir = input.launchDir?.trim() || null;
  const launchCmd = windowsProgramPath(input.launchCmd?.trim().slice(0, 500) || null);
  if (launchDir && (!isAbsolute(launchDir) || !existsSync(launchDir) || !statSync(launchDir).isDirectory()))
    throw new GameInputError("Server folder must be a full path to a folder that exists, e.g. C:\\...\\poker-tournament");
  if (Boolean(launchDir) !== Boolean(launchCmd)) throw new GameInputError("Fill in both the server folder and the start command, or neither");
  const funnelPort = Number(input.funnelPort ?? 443);
  if (!FUNNEL_PORTS.includes(funnelPort as (typeof FUNNEL_PORTS)[number])) throw new GameInputError("Public port must be 443, 8443 or 10000");
  return { launchDir, launchCmd, autostart: Boolean(input.autostart && launchDir), publicAccess: Boolean(input.publicAccess && launchDir), funnelPort };
}

function checkFunnelPortFree(id: number | null, launch: { publicAccess: boolean; funnelPort: number }) {
  if (!launch.publicAccess) return;
  const clash = listGames().find((g) => g.id !== id && g.publicAccess && g.funnelPort === launch.funnelPort);
  if (clash) throw new GameInputError(`${clash.name} already uses public port ${launch.funnelPort}. Pick another (443, 8443 or 10000).`);
}

export function addGame(input: { key: string; name: string; baseUrl: string; secret?: string } & LaunchInput): Game {
  const key = String(input.key ?? "").trim().toLowerCase();
  if (!KEY_RE.test(key)) throw new GameInputError("Key must be lowercase letters, numbers or dashes, e.g. poker");
  if (getGameByKey(key)) throw new GameInputError(`A game with key "${key}" already exists`);
  const baseUrl = normalizeUrl(input.baseUrl);
  const secret = input.secret?.trim() || randomBytes(32).toString("hex");
  const name = String(input.name ?? "").trim().slice(0, 60) || key;
  const launch = cleanLaunch(input);
  checkFunnelPortFree(null, launch);
  const r = db
    .prepare(
      `INSERT INTO games (key, name, base_url, secret, launch_dir, launch_cmd, autostart, public_access, funnel_port, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(key, name, baseUrl, secret, launch.launchDir, launch.launchCmd, Number(launch.autostart), Number(launch.publicAccess), launch.funnelPort, Date.now()) as GameDbRow;
  return toGame(r);
}

export function updateGame(id: number, patch: { name?: string; baseUrl?: string; enabled?: boolean; secret?: string } & LaunchInput) {
  const g = getGame(id);
  if (!g) throw new GameInputError("Game not found");
  const launch = cleanLaunch({
    launchDir: patch.launchDir !== undefined ? patch.launchDir : g.launchDir,
    launchCmd: patch.launchCmd !== undefined ? patch.launchCmd : g.launchCmd,
    autostart: patch.autostart ?? g.autostart,
    publicAccess: patch.publicAccess ?? g.publicAccess,
    funnelPort: patch.funnelPort ?? g.funnelPort,
  });
  checkFunnelPortFree(id, launch);
  db.prepare(`UPDATE games SET launch_dir = ?, launch_cmd = ?, autostart = ?, public_access = ?, funnel_port = ? WHERE id = ?`).run(
    launch.launchDir,
    launch.launchCmd,
    Number(launch.autostart),
    Number(launch.publicAccess),
    launch.funnelPort,
    id,
  );
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
  /** Asks the game server to save and exit. Optional in the contract: a 404 means "not supported". */
  shutdown: (g: Game) => call<{ ok: boolean }>(g, "POST", "/api/integration/shutdown", {}),
};
