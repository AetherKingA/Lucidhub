import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

// WAL keeps writes fast and the file consistent if the PC loses power mid-write.
// Only accounts and sessions: this game stores no IP addresses.
db.exec(`
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY,
    discord_id  TEXT NOT NULL UNIQUE,
    username    TEXT NOT NULL,
    avatar      TEXT,
    banned      INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    last_login  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL
  );
`);

export interface User {
  id: number;
  discordId: string;
  username: string;
  avatar: string | null;
  banned: boolean;
}

type UserRow = { id: number; discord_id: string; username: string; avatar: string | null; banned: number };

const toUser = (r: UserRow): User => ({
  id: r.id,
  discordId: r.discord_id,
  username: r.username,
  avatar: r.avatar,
  banned: r.banned === 1,
});

const upsertUserStmt = db.prepare(`
  INSERT INTO users (discord_id, username, avatar, created_at, last_login)
  VALUES (:discordId, :username, :avatar, :now, :now)
  ON CONFLICT(discord_id) DO UPDATE SET username = :username, avatar = :avatar, last_login = :now
  RETURNING id, discord_id, username, avatar, banned
`);

/** One site account per Discord account: the Discord ID is the unique key. */
export function upsertUser(discordId: string, username: string, avatar: string | null): User {
  return toUser(upsertUserStmt.get({ discordId, username, avatar, now: Date.now() }) as UserRow);
}

const sessionUserStmt = db.prepare(`
  SELECT u.id, u.discord_id, u.username, u.avatar, u.banned
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ? AND s.expires_at > ?
`);
const insertSessionStmt = db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`);
const deleteSessionStmt = db.prepare(`DELETE FROM sessions WHERE token_hash = ?`);
const purgeSessionsStmt = db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`);

export function findSessionUser(tokenHash: string): User | null {
  const row = sessionUserStmt.get(tokenHash, Date.now()) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function createSession(tokenHash: string, userId: number, expiresAt: number) {
  purgeSessionsStmt.run(Date.now());
  insertSessionStmt.run(tokenHash, userId, expiresAt);
}

export function deleteSession(tokenHash: string) {
  deleteSessionStmt.run(tokenHash);
}

const userByDiscordStmt = db.prepare(`SELECT id, discord_id, username, avatar, banned FROM users WHERE discord_id = ?`);
const discordIdStmt = db.prepare(`SELECT discord_id FROM users WHERE id = ?`);
const visitsStmt = db.prepare(`SELECT created_at, last_login FROM users WHERE id = ?`);

/** The site account for a Discord account, for the hub (which only knows Discord IDs). */
export function findUserByDiscordId(discordId: string): User | null {
  const r = userByDiscordStmt.get(discordId) as UserRow | undefined;
  return r ? toUser(r) : null;
}

export function discordIdOf(userId: number): string | null {
  return (discordIdStmt.get(userId) as { discord_id: string } | undefined)?.discord_id ?? null;
}

/** First and latest sign-in, for the admin's player details in the hub. */
export function visits(userId: number): { firstVisit: number | null; lastVisit: number | null } {
  const v = visitsStmt.get(userId) as { created_at: number; last_login: number } | undefined;
  return { firstVisit: v?.created_at ?? null, lastVisit: v?.last_login ?? null };
}
