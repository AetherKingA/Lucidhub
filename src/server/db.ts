import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

// WAL keeps writes fast and the file consistent if the PC loses power mid-write.
db.exec(`
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

  -- Every IP each account has used, so admins can review accounts sharing an IP.
  CREATE TABLE IF NOT EXISTS user_ips (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip          TEXT NOT NULL,
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    PRIMARY KEY (user_id, ip)
  );
  CREATE INDEX IF NOT EXISTS user_ips_ip ON user_ips(ip);
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

const recordIpStmt = db.prepare(`
  INSERT INTO user_ips (user_id, ip, first_seen, last_seen) VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id, ip) DO UPDATE SET last_seen = excluded.last_seen
`);

export function recordIp(userId: number, ip: string) {
  const now = Date.now();
  recordIpStmt.run(userId, ip, now, now);
}

const sharedIpStmt = db.prepare(`
  SELECT DISTINCT b.user_id AS userId FROM user_ips a
  JOIN user_ips b ON a.ip = b.ip AND b.user_id != a.user_id
  WHERE a.user_id = ?
`);

/** Other accounts that have used any of this account's IPs. Used to flag players at the same table. */
export function usersSharingIp(userId: number): number[] {
  return (sharedIpStmt.all(userId) as { userId: number }[]).map((r) => r.userId);
}
