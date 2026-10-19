import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

// WAL keeps writes fast and the file consistent if the PC loses power mid-write.
db.exec(`
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  -- Game sites that plug into the hub, one row per game. See INTEGRATION.md.
  CREATE TABLE IF NOT EXISTS games (
    id          INTEGER PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    base_url    TEXT NOT NULL,
    secret      TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    last_ok_at  INTEGER,
    last_error  TEXT,
    created_at  INTEGER NOT NULL
  );

  -- One row per event on a game site, mirrored from the game. processed_at is set once prizes are awarded.
  CREATE TABLE IF NOT EXISTS events (
    id                  INTEGER PRIMARY KEY,
    game_id             INTEGER NOT NULL REFERENCES games(id),
    external_id         TEXT NOT NULL,
    name                TEXT NOT NULL,
    status              TEXT NOT NULL,
    start_time          INTEGER,
    entrants            INTEGER NOT NULL DEFAULT 0,
    max_players         INTEGER,
    url                 TEXT,
    announce_channel_id TEXT,
    processed_at        INTEGER,
    announced_at        INTEGER,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    UNIQUE (game_id, external_id)
  );

  CREATE TABLE IF NOT EXISTS prizes (
    id                  INTEGER PRIMARY KEY,
    name                TEXT NOT NULL,
    type                TEXT NOT NULL CHECK (type IN ('code_pool', 'message')),
    message             TEXT NOT NULL,
    image_url           TEXT,
    low_stock_threshold INTEGER NOT NULL DEFAULT 2,
    archived            INTEGER NOT NULL DEFAULT 0,
    low_stock_alerted   INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL
  );

  -- Codes in a pool. award_id is set when a code is reserved for a winner, and never cleared.
  CREATE TABLE IF NOT EXISTS prize_codes (
    id        INTEGER PRIMARY KEY,
    prize_id  INTEGER NOT NULL REFERENCES prizes(id) ON DELETE CASCADE,
    code      TEXT NOT NULL,
    award_id  INTEGER,
    added_at  INTEGER NOT NULL,
    UNIQUE (prize_id, code)
  );
  CREATE INDEX IF NOT EXISTS prize_codes_free ON prize_codes(prize_id, award_id);

  -- Places place_from..place_to of an event each win one of prize_id.
  CREATE TABLE IF NOT EXISTS prize_rules (
    id          INTEGER PRIMARY KEY,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    place_from  INTEGER NOT NULL,
    place_to    INTEGER NOT NULL,
    prize_id    INTEGER NOT NULL REFERENCES prizes(id)
  );

  -- Reusable prize ladders, e.g. "Weekly poker": [{placeFrom, placeTo, prizeId}].
  CREATE TABLE IF NOT EXISTS templates (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    rules_json  TEXT NOT NULL
  );

  -- Blind structures you saved for a game (on top of the presets the game ships with).
  CREATE TABLE IF NOT EXISTS blind_presets (
    id           INTEGER PRIMARY KEY,
    game_key     TEXT NOT NULL,
    name         TEXT NOT NULL,
    levels_json  TEXT NOT NULL,
    set_json     TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  );

  -- One prize for one winner. The unique key makes awarding an event twice a no-op.
  CREATE TABLE IF NOT EXISTS awards (
    id               INTEGER PRIMARY KEY,
    event_id         INTEGER NOT NULL REFERENCES events(id),
    rule_id          INTEGER NOT NULL,
    prize_id         INTEGER NOT NULL REFERENCES prizes(id),
    discord_id       TEXT NOT NULL,
    username         TEXT NOT NULL,
    place            INTEGER NOT NULL,
    code_id          INTEGER REFERENCES prize_codes(id),
    status           TEXT NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    sent_at          INTEGER,
    created_at       INTEGER NOT NULL,
    UNIQUE (event_id, rule_id, discord_id)
  );
  CREATE INDEX IF NOT EXISTS awards_status ON awards(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS awards_user ON awards(discord_id);

  CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id      INTEGER PRIMARY KEY,
    at      INTEGER NOT NULL,
    actor   TEXT NOT NULL,
    action  TEXT NOT NULL,
    detail  TEXT
  );

  -- Dashboard logins (admins only).
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    discord_id  TEXT NOT NULL,
    username    TEXT NOT NULL,
    avatar      TEXT,
    expires_at  INTEGER NOT NULL
  );
`);

// Columns added after the first release. SQLite can't "ADD COLUMN IF NOT EXISTS", so check first.
function addColumn(table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
// How the hub starts a game's server: a folder, a command run there, and whether to start it with the hub.
addColumn("games", "launch_dir", "TEXT");
addColumn("games", "launch_cmd", "TEXT");
addColumn("games", "autostart", "INTEGER NOT NULL DEFAULT 0");
// Open the game to the internet with Tailscale Funnel while it runs, and on which public HTTPS port.
addColumn("games", "public_access", "INTEGER NOT NULL DEFAULT 0");
addColumn("games", "funnel_port", "INTEGER NOT NULL DEFAULT 443");
// Open or closed lobby, and how many players are waiting to be let in (games that support it).
addColumn("events", "access", "TEXT");
addColumn("events", "pending", "INTEGER NOT NULL DEFAULT 0");
addColumn("events", "watch_url", "TEXT");

/** Runs fn in a transaction; rolls back if it throws. */
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---------------------------------------------------------------- settings

export interface Settings {
  /** Discord server the bot works in. */
  guildId: string;
  /** Where winners are announced unless an event picks its own channel. */
  announceChannelId: string;
  /** Where the bot posts alerts for you (low stock, failed DMs, game offline). Empty = DM the admins. */
  alertsChannelId: string;
}

const SETTING_DEFAULTS: Settings = { guildId: "", announceChannelId: "", alertsChannelId: "" };
const getSettingStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const setSettingStmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

export function getSettings(): Settings {
  const out = { ...SETTING_DEFAULTS };
  for (const key of Object.keys(SETTING_DEFAULTS) as (keyof Settings)[]) {
    const row = getSettingStmt.get(key) as { value: string } | undefined;
    if (row) out[key] = row.value;
  }
  return out;
}

export function saveSettings(patch: Partial<Settings>) {
  for (const key of Object.keys(SETTING_DEFAULTS) as (keyof Settings)[]) {
    const v = patch[key];
    if (typeof v === "string") setSettingStmt.run(key, v.trim());
  }
}

// ---------------------------------------------------------------- audit log

const auditStmt = db.prepare(`INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)`);

/** Records who did what. actor is an admin's name, or "system" / "bot". */
export function audit(actor: string, action: string, detail?: string) {
  auditStmt.run(Date.now(), actor, action, detail ?? null);
  console.log(`[${actor}] ${action}${detail ? ` — ${detail}` : ""}`);
}

export function recentAudit(limit = 100) {
  return db.prepare(`SELECT id, at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT ?`).all(limit);
}

// ---------------------------------------------------------------- sessions

export interface Admin {
  discordId: string;
  username: string;
  avatar: string | null;
}

const purgeSessionsStmt = db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`);
const insertSessionStmt = db.prepare(`INSERT INTO sessions (token_hash, discord_id, username, avatar, expires_at) VALUES (?, ?, ?, ?, ?)`);
const findSessionStmt = db.prepare(`SELECT discord_id, username, avatar FROM sessions WHERE token_hash = ? AND expires_at > ?`);
const deleteSessionStmt = db.prepare(`DELETE FROM sessions WHERE token_hash = ?`);

export function createSession(tokenHash: string, admin: Admin, expiresAt: number) {
  purgeSessionsStmt.run(Date.now());
  insertSessionStmt.run(tokenHash, admin.discordId, admin.username, admin.avatar, expiresAt);
}

export function findSession(tokenHash: string): Admin | null {
  const row = findSessionStmt.get(tokenHash, Date.now()) as { discord_id: string; username: string; avatar: string | null } | undefined;
  return row ? { discordId: row.discord_id, username: row.username, avatar: row.avatar } : null;
}

export function deleteSession(tokenHash: string) {
  deleteSessionStmt.run(tokenHash);
}
