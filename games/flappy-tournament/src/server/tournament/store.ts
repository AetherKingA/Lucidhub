// Saves tournaments to SQLite: one row per tournament (best runs included), plus the final places.
// The manager batches writes into one transaction every ~200 ms.

import { db } from "../db.ts";
import type { TournamentMeta } from "./types.ts";

db.exec(`
  CREATE TABLE IF NOT EXISTS tournaments (
    id          INTEGER PRIMARY KEY,
    status      TEXT NOT NULL,
    meta_json   TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tournament_results (
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    place         INTEGER NOT NULL,
    PRIMARY KEY (tournament_id, user_id)
  );
`);

const insertStmt = db.prepare(`INSERT INTO tournaments (status, meta_json, updated_at) VALUES ('registering', '{}', ?) RETURNING id`);
const saveMetaStmt = db.prepare(`UPDATE tournaments SET status = ?, meta_json = ?, updated_at = ? WHERE id = ?`);
const loadMetaStmt = db.prepare(`
  SELECT meta_json FROM tournaments
  WHERE status IN ('registering', 'running', 'finale') OR updated_at > ?
  ORDER BY id
`);
const saveResultStmt = db.prepare(`
  INSERT INTO tournament_results (tournament_id, user_id, place) VALUES (?, ?, ?)
  ON CONFLICT(tournament_id, user_id) DO UPDATE SET place = excluded.place
`);

/** Reserves an id for a new tournament. */
export function insertTournament(now: number): number {
  return (insertStmt.get(now) as { id: number }).id;
}

export function saveMetas(metas: TournamentMeta[], now: number) {
  if (!metas.length) return;
  db.exec("BEGIN");
  try {
    for (const m of metas) saveMetaStmt.run(m.status, JSON.stringify(m), now, m.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const parseMeta = (r: { meta_json: string } | undefined) => {
  const meta = r ? (JSON.parse(r.meta_json) as TournamentMeta) : null;
  return meta?.id === undefined ? null : meta;
};

/** Active tournaments, plus ones that ended in the last day (so the lobby can show results). */
export function loadTournaments(now: number): TournamentMeta[] {
  return (loadMetaStmt.all(now - 86_400_000) as { meta_json: string }[]).flatMap((r) => parseMeta(r) ?? []);
}

const metaByIdStmt = db.prepare(`SELECT meta_json FROM tournaments WHERE id = ?`);
const endedSinceStmt = db.prepare(`
  SELECT meta_json FROM tournaments
  WHERE status IN ('finished', 'cancelled') AND updated_at >= ?
  ORDER BY id
`);
const resultsStmt = db.prepare(`
  SELECT u.discord_id AS discordId, u.username, r.place
  FROM tournament_results r JOIN users u ON u.id = r.user_id
  WHERE r.tournament_id = ?
  ORDER BY r.place, u.username
`);

/** A saved tournament, including ones that have already left memory. */
export function loadMeta(id: number): TournamentMeta | null {
  return parseMeta(metaByIdStmt.get(id) as { meta_json: string } | undefined);
}

/** Finished or cancelled tournaments last saved at or after `since`. */
export function loadEndedMetas(since: number): TournamentMeta[] {
  return (endedSinceStmt.all(since) as { meta_json: string }[]).flatMap((r) => parseMeta(r) ?? []);
}

/** Final places, best first. */
export function loadResults(tournamentId: number): { discordId: string; username: string; place: number }[] {
  return (resultsStmt.all(tournamentId) as { discordId: string; username: string; place: number }[]).map((r) => ({ ...r }));
}

export function saveResults(tournamentId: number, rows: { userId: number; place: number }[]) {
  db.exec("BEGIN");
  try {
    for (const r of rows) saveResultStmt.run(tournamentId, r.userId, r.place);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
