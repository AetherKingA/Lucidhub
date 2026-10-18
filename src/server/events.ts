// Events mirrored from game sites, plus each event's prize ladder.

import type { GameEvent, HubEvent, PrizeRule } from "../shared/protocol.ts";
import { db, tx } from "./db.ts";
import { cleanRules } from "./prizes.ts";

type EventDbRow = {
  id: number;
  game_id: number;
  game_name: string;
  external_id: string;
  name: string;
  status: HubEvent["status"];
  start_time: number | null;
  entrants: number;
  max_players: number | null;
  url: string | null;
  announce_channel_id: string | null;
  processed_at: number | null;
};

const EVENT_SELECT = `SELECT e.*, g.name AS game_name FROM events e JOIN games g ON g.id = e.game_id`;

const rulesStmt = db.prepare(`SELECT id, place_from, place_to, prize_id FROM prize_rules WHERE event_id = ? ORDER BY place_from, id`);
const countsStmt = db.prepare(`SELECT status, COUNT(*) AS n FROM awards WHERE event_id = ? GROUP BY status`);

export function rulesFor(eventId: number): Required<PrizeRule>[] {
  return (rulesStmt.all(eventId) as { id: number; place_from: number; place_to: number; prize_id: number }[]).map((r) => ({
    id: r.id,
    placeFrom: r.place_from,
    placeTo: r.place_to,
    prizeId: r.prize_id,
  }));
}

function toEvent(r: EventDbRow): HubEvent {
  const awardCounts: Record<string, number> = {};
  for (const c of countsStmt.all(r.id) as { status: string; n: number }[]) awardCounts[c.status] = c.n;
  return {
    id: r.id,
    gameId: r.game_id,
    gameName: r.game_name,
    externalId: r.external_id,
    name: r.name,
    status: r.status,
    startTime: r.start_time,
    entrants: r.entrants,
    maxPlayers: r.max_players,
    url: r.url,
    announceChannelId: r.announce_channel_id,
    processedAt: r.processed_at,
    rules: rulesFor(r.id),
    awardCounts,
  };
}

export function listEvents(filter: { status?: string; limit?: number } = {}): HubEvent[] {
  const rows = filter.status
    ? (db.prepare(`${EVENT_SELECT} WHERE e.status = ? ORDER BY e.start_time DESC LIMIT ?`).all(filter.status, filter.limit ?? 200) as EventDbRow[])
    : (db.prepare(`${EVENT_SELECT} ORDER BY (e.status IN ('registering','running')) DESC, e.start_time DESC LIMIT ?`).all(filter.limit ?? 200) as EventDbRow[]);
  return rows.map(toEvent);
}

export function getEvent(id: number): HubEvent | null {
  const r = db.prepare(`${EVENT_SELECT} WHERE e.id = ?`).get(id) as EventDbRow | undefined;
  return r ? toEvent(r) : null;
}

export function findEvent(gameId: number, externalId: string): HubEvent | null {
  const r = db.prepare(`${EVENT_SELECT} WHERE e.game_id = ? AND e.external_id = ?`).get(gameId, externalId) as EventDbRow | undefined;
  return r ? toEvent(r) : null;
}

/** Inserts or refreshes an event from what the game reports. Events made on the game site itself show up this way too. */
export function upsertEvent(gameId: number, e: GameEvent): HubEvent {
  const now = Date.now();
  const { id } = db
    .prepare(
      `INSERT INTO events (game_id, external_id, name, status, start_time, entrants, max_players, url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_id, external_id) DO UPDATE SET
         name = excluded.name, status = excluded.status, start_time = excluded.start_time, entrants = excluded.entrants,
         max_players = excluded.max_players, url = excluded.url, updated_at = excluded.updated_at
       RETURNING id`,
    )
    .get(gameId, String(e.id), String(e.name).slice(0, 100), e.status, e.startTime ?? null, Number(e.entrants) || 0, e.maxPlayers ?? null, e.url ?? null, now, now) as {
    id: number;
  };
  return getEvent(id)!;
}

export class EventLockedError extends Error {}

/**
 * Replaces an event's prize ladder. Locked once prizes have been handed out, so nobody gets a different
 * prize afterwards. A finished event that had no ladder can still get one (the route then awards it).
 */
export function setRules(eventId: number, rules: PrizeRule[]) {
  const ev = getEvent(eventId);
  if (!ev) throw new EventLockedError("Event not found");
  const awarded = Object.values(ev.awardCounts).reduce((a, b) => a + b, 0);
  if (awarded) throw new EventLockedError("Prizes for this event were already awarded, so its ladder is locked");
  const clean = cleanRules(rules);
  tx(() => {
    db.prepare(`DELETE FROM prize_rules WHERE event_id = ?`).run(eventId);
    const ins = db.prepare(`INSERT INTO prize_rules (event_id, place_from, place_to, prize_id) VALUES (?, ?, ?, ?)`);
    for (const r of clean) ins.run(eventId, r.placeFrom, r.placeTo, r.prizeId);
  });
}

export function setAnnounceChannel(eventId: number, channelId: string | null) {
  db.prepare(`UPDATE events SET announce_channel_id = ? WHERE id = ?`).run(channelId?.trim() || null, eventId);
}

export function markProcessed(eventId: number) {
  db.prepare(`UPDATE events SET processed_at = ? WHERE id = ? AND processed_at IS NULL`).run(Date.now(), eventId);
}

export function markAnnounced(eventId: number) {
  db.prepare(`UPDATE events SET announced_at = ? WHERE id = ?`).run(Date.now(), eventId);
}

/** Finished or cancelled events whose prizes haven't been handled yet. */
export function unprocessedEnded(): { id: number; gameId: number; externalId: string; status: string }[] {
  return (
    db.prepare(`SELECT id, game_id, external_id, status FROM events WHERE processed_at IS NULL AND status IN ('finished','cancelled')`).all() as {
      id: number;
      game_id: number;
      external_id: string;
      status: string;
    }[]
  ).map((r) => ({ id: r.id, gameId: r.game_id, externalId: r.external_id, status: r.status }));
}

/** Processed events whose winners haven't been announced (all their DMs have been attempted). */
export function unannounced(): number[] {
  return (
    db
      .prepare(
        `SELECT e.id FROM events e WHERE e.processed_at IS NOT NULL AND e.announced_at IS NULL AND e.status = 'finished'
         AND EXISTS (SELECT 1 FROM awards a WHERE a.event_id = e.id)
         AND NOT EXISTS (SELECT 1 FROM awards a WHERE a.event_id = e.id AND a.status = 'pending' AND a.attempts = 0)`,
      )
      .all() as { id: number }[]
  ).map((r) => r.id);
}
