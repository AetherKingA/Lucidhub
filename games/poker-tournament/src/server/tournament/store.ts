// Saves tournaments to SQLite. Each tournament is one meta row plus one row per table, so a single
// action only rewrites that table's row. The manager batches writes into one transaction every
// ~200 ms, so a crash loses at most a fraction of a second of play.

import { db } from "../db.ts";
import type { TableState, TournamentConfig, TournamentMeta } from "./types.ts";

db.exec(`
  CREATE TABLE IF NOT EXISTS tournaments (
    id          INTEGER PRIMARY KEY,
    status      TEXT NOT NULL,
    meta_json   TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tournament_tables (
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    table_id      INTEGER NOT NULL,
    state_json    TEXT NOT NULL,
    PRIMARY KEY (tournament_id, table_id)
  );
  CREATE TABLE IF NOT EXISTS tournament_results (
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    place         INTEGER NOT NULL,
    points        INTEGER NOT NULL,
    PRIMARY KEY (tournament_id, user_id)
  );
`);

const insertStmt = db.prepare(`INSERT INTO tournaments (status, meta_json, updated_at) VALUES ('registering', '{}', ?) RETURNING id`);
const saveMetaStmt = db.prepare(`UPDATE tournaments SET status = ?, meta_json = ?, updated_at = ? WHERE id = ?`);
const saveTableStmt = db.prepare(`
  INSERT INTO tournament_tables (tournament_id, table_id, state_json) VALUES (?, ?, ?)
  ON CONFLICT(tournament_id, table_id) DO UPDATE SET state_json = excluded.state_json
`);
const deleteTableStmt = db.prepare(`DELETE FROM tournament_tables WHERE tournament_id = ? AND table_id = ?`);
const loadMetaStmt = db.prepare(`
  SELECT meta_json FROM tournaments
  WHERE status IN ('registering', 'running') OR updated_at > ?
  ORDER BY id
`);
const loadTablesStmt = db.prepare(`SELECT state_json FROM tournament_tables WHERE tournament_id = ?`);
const saveResultStmt = db.prepare(`
  INSERT INTO tournament_results (tournament_id, user_id, place, points) VALUES (?, ?, ?, ?)
  ON CONFLICT(tournament_id, user_id) DO UPDATE SET place = excluded.place, points = excluded.points
`);

/** Reserves an id for a new tournament. */
export function insertTournament(_config: TournamentConfig, now: number): number {
  return (insertStmt.get(now) as { id: number }).id;
}

export interface SaveBatch {
  metas: TournamentMeta[];
  tables: { tournamentId: number; tableId: number; state: TableState | null }[];
}

export function saveBatch(batch: SaveBatch, now: number) {
  if (!batch.metas.length && !batch.tables.length) return;
  db.exec("BEGIN");
  try {
    for (const m of batch.metas) saveMetaStmt.run(m.status, JSON.stringify(m), now, m.id);
    for (const t of batch.tables) {
      if (t.state) saveTableStmt.run(t.tournamentId, t.tableId, JSON.stringify(t.state));
      else deleteTableStmt.run(t.tournamentId, t.tableId);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Active tournaments, plus ones that ended in the last day (so the lobby can show results). */
export function loadTournaments(now: number): { meta: TournamentMeta; tables: TableState[] }[] {
  return (loadMetaStmt.all(now - 86_400_000) as { meta_json: string }[])
    .map((r) => JSON.parse(r.meta_json) as TournamentMeta)
    .filter((meta) => meta.id !== undefined)
    .map((meta) => ({
      meta,
      tables: (loadTablesStmt.all(meta.id) as { state_json: string }[]).map((r) => JSON.parse(r.state_json) as TableState),
    }));
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
  ORDER BY r.place
`);

const parseMeta = (r: { meta_json: string } | undefined) => {
  const meta = r ? (JSON.parse(r.meta_json) as TournamentMeta) : null;
  return meta?.id === undefined ? null : meta;
};

/** A saved tournament, including ones that have already left memory. Null if unknown or never saved. */
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

export function saveResult(tournamentId: number, userId: number, place: number, points: number) {
  saveResultStmt.run(tournamentId, userId, place, points);
}
