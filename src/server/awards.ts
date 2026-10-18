// Turns finished events into awards: matches finishing places to the prize ladder and reserves a code
// for each code-pool prize. Everything here is idempotent, so the webhook and the background
// reconcile can both call awardEvent for the same event without anyone getting a prize twice.

import type { Award, AwardStatus, GameResults } from "../shared/protocol.ts";
import { raiseAlert } from "./alerts.ts";
import { audit, db, tx } from "./db.ts";
import { getEvent, markProcessed, rulesFor } from "./events.ts";
import { gameClient, getGame } from "./games.ts";
import { getPrize } from "./prizes.ts";

const DISCORD_ID_RE = /^\d{5,25}$/;

const freeCodeStmt = db.prepare(`SELECT id FROM prize_codes WHERE prize_id = ? AND award_id IS NULL ORDER BY id LIMIT 1`);
const claimCodeStmt = db.prepare(`UPDATE prize_codes SET award_id = ? WHERE id = ? AND award_id IS NULL`);
const setAwardCodeStmt = db.prepare(`UPDATE awards SET code_id = ?, status = 'pending', next_attempt_at = 0 WHERE id = ?`);

/** Gives the award the next unused code from its prize's pool. Returns false if the pool is empty. */
function reserveCode(awardId: number, prizeId: number): boolean {
  const free = freeCodeStmt.get(prizeId) as { id: number } | undefined;
  if (!free) return false;
  if (Number(claimCodeStmt.run(awardId, free.id).changes) !== 1) return false;
  setAwardCodeStmt.run(free.id, awardId);
  return true;
}

function checkStock(prizeId: number) {
  const p = getPrize(prizeId);
  if (!p || p.type !== "code_pool") return;
  if (p.stock === 0) raiseAlert(`out:${p.id}`, `**${p.name}** is out of codes. Winners are waiting — add codes in the dashboard and they'll be sent automatically.`);
  else if (p.stock <= p.lowStockThreshold) {
    const row = db.prepare(`UPDATE prizes SET low_stock_alerted = 1 WHERE id = ? AND low_stock_alerted = 0`).run(p.id);
    if (Number(row.changes) === 1) raiseAlert(`low:${p.id}`, `**${p.name}** is running low: ${p.stock} code${p.stock === 1 ? "" : "s"} left.`);
  }
}

/**
 * Creates the awards for an event's results. Safe to call again: existing awards are kept as they are.
 * Returns how many new awards were created.
 */
export function createAwards(eventId: number, results: GameResults["results"]): { created: number; waiting: number; skipped: number } {
  const rules = rulesFor(eventId);
  const insert = db.prepare(
    `INSERT INTO awards (event_id, rule_id, prize_id, discord_id, username, place, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, rule_id, discord_id) DO NOTHING
     RETURNING id`,
  );
  let created = 0;
  let waiting = 0;
  let skipped = 0;
  const touchedPrizes = new Set<number>();
  tx(() => {
    for (const result of results) {
      const discordId = String(result.discordId ?? "");
      const place = Number(result.place);
      if (!DISCORD_ID_RE.test(discordId) || !Number.isInteger(place)) {
        skipped++;
        continue;
      }
      for (const rule of rules) {
        if (place < rule.placeFrom || place > rule.placeTo) continue;
        const prize = getPrize(rule.prizeId);
        if (!prize) continue;
        const status: AwardStatus = prize.type === "code_pool" ? "waiting_stock" : "pending";
        const row = insert.get(eventId, rule.id, prize.id, discordId, String(result.username ?? "").slice(0, 80) || "Winner", place, status, Date.now()) as
          | { id: number }
          | undefined;
        if (!row) continue; // already awarded
        created++;
        if (prize.type === "code_pool") {
          touchedPrizes.add(prize.id);
          if (!reserveCode(row.id, prize.id)) waiting++;
        }
      }
    }
    markProcessed(eventId);
  });
  for (const id of touchedPrizes) checkStock(id);
  return { created, waiting, skipped };
}

const inFlight = new Set<number>();

/** Fetches an ended event's results from its game and hands out its prizes. */
export async function awardEvent(eventId: number, actor = "system") {
  if (inFlight.has(eventId)) return null;
  inFlight.add(eventId);
  try {
    const ev = getEvent(eventId);
    if (!ev) return null;
    const game = getGame(ev.gameId);
    if (!game) return null;
    const res = await gameClient.results(game, ev.externalId);
    if (res.status === "cancelled") {
      markProcessed(eventId);
      audit(actor, "event cancelled", `${ev.name}: no prizes awarded`);
      return { created: 0, waiting: 0, skipped: 0 };
    }
    if (res.status !== "finished") return null;
    db.prepare(`UPDATE events SET status = 'finished' WHERE id = ?`).run(eventId);
    const out = createAwards(eventId, res.results);
    if (ev.rules.length === 0) audit(actor, "event finished", `${ev.name}: no prize ladder, nothing to send`);
    else audit(actor, "prizes awarded", `${ev.name}: ${out.created} award(s)${out.waiting ? `, ${out.waiting} waiting for codes` : ""}${out.skipped ? `, ${out.skipped} result(s) without a Discord account` : ""}`);
    return out;
  } finally {
    inFlight.delete(eventId);
  }
}

/** After codes are added: gives codes to winners who were waiting for stock, oldest first. */
export function fillWaitingAwards(prizeId?: number): number {
  const waiting = (
    prizeId === undefined
      ? db.prepare(`SELECT id, prize_id FROM awards WHERE status = 'waiting_stock' ORDER BY id`).all()
      : db.prepare(`SELECT id, prize_id FROM awards WHERE status = 'waiting_stock' AND prize_id = ? ORDER BY id`).all(prizeId)
  ) as { id: number; prize_id: number }[];
  let filled = 0;
  tx(() => {
    for (const a of waiting) if (reserveCode(a.id, a.prize_id)) filled++;
  });
  if (filled) audit("system", "codes assigned", `${filled} waiting winner(s) got codes`);
  for (const id of new Set(waiting.map((a) => a.prize_id))) checkStock(id);
  return filled;
}

// ---------------------------------------------------------------- reading + admin actions

type AwardDbRow = {
  id: number;
  event_id: number;
  event_name: string;
  prize_id: number;
  prize_name: string;
  discord_id: string;
  username: string;
  place: number;
  status: AwardStatus;
  attempts: number;
  last_error: string | null;
  sent_at: number | null;
  created_at: number;
  code_id: number | null;
};

const AWARD_SELECT = `
  SELECT a.*, e.name AS event_name, p.name AS prize_name
  FROM awards a JOIN events e ON e.id = a.event_id JOIN prizes p ON p.id = a.prize_id`;

const toAward = (r: AwardDbRow): Award => ({
  id: r.id,
  eventId: r.event_id,
  eventName: r.event_name,
  prizeId: r.prize_id,
  prizeName: r.prize_name,
  discordId: r.discord_id,
  username: r.username,
  place: r.place,
  status: r.status,
  attempts: r.attempts,
  lastError: r.last_error,
  sentAt: r.sent_at,
  createdAt: r.created_at,
  hasCode: r.code_id !== null,
});

export function listAwards(filter: { status?: string; eventId?: number; limit?: number } = {}): Award[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.status) {
    where.push("a.status = ?");
    args.push(filter.status);
  }
  if (filter.eventId) {
    where.push("a.event_id = ?");
    args.push(filter.eventId);
  }
  const sql = `${AWARD_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.id DESC LIMIT ?`;
  return (db.prepare(sql).all(...args, Math.min(filter.limit ?? 200, 1000)) as AwardDbRow[]).map(toAward);
}

export function getAward(id: number): Award | null {
  const r = db.prepare(`${AWARD_SELECT} WHERE a.id = ?`).get(id) as AwardDbRow | undefined;
  return r ? toAward(r) : null;
}

/** What the winner is told: the prize message with its placeholders filled in. */
export function renderAward(awardId: number): { text: string; imageUrl: string | null; prizeName: string; eventName: string } | null {
  const r = db
    .prepare(
      `SELECT a.discord_id, a.place, p.name AS prize_name, p.message, p.image_url, e.name AS event_name, c.code
       FROM awards a JOIN prizes p ON p.id = a.prize_id JOIN events e ON e.id = a.event_id
       LEFT JOIN prize_codes c ON c.id = a.code_id WHERE a.id = ?`,
    )
    .get(awardId) as { discord_id: string; place: number; prize_name: string; message: string; image_url: string | null; event_name: string; code: string | null } | undefined;
  if (!r) return null;
  const vars: Record<string, string> = {
    user: `<@${r.discord_id}>`,
    place: String(r.place),
    event: r.event_name,
    prize: r.prize_name,
    code: r.code ?? "",
  };
  const text = r.message.replace(/\{(user|place|event|prize|code)\}/g, (_, k: string) => vars[k]!);
  return { text, imageUrl: r.image_url, prizeName: r.prize_name, eventName: r.event_name };
}

/** A winner's prizes for /prizes: everything already sent (or that couldn't be DM'd), newest first. */
export function prizesForUser(discordId: string): { awardId: number; eventName: string; place: number; status: AwardStatus }[] {
  return (
    db
      .prepare(
        `SELECT a.id, e.name AS event_name, a.place, a.status FROM awards a JOIN events e ON e.id = a.event_id
         WHERE a.discord_id = ? AND a.status IN ('sent','dm_failed','manual','pending','waiting_stock') ORDER BY a.id DESC LIMIT 20`,
      )
      .all(discordId) as { id: number; event_name: string; place: number; status: AwardStatus }[]
  ).map((r) => ({ awardId: r.id, eventName: r.event_name, place: r.place, status: r.status }));
}

export class AwardActionError extends Error {}

export function resendAward(id: number, actor: string) {
  const a = getAward(id);
  if (!a) throw new AwardActionError("Award not found");
  if (a.status === "waiting_stock") throw new AwardActionError("This prize is waiting for codes — add codes to its pool");
  db.prepare(`UPDATE awards SET status = 'pending', attempts = 0, next_attempt_at = 0, last_error = NULL WHERE id = ?`).run(id);
  audit(actor, "resend prize", `${a.prizeName} to ${a.username}`);
}

export function cancelAward(id: number, actor: string) {
  const a = getAward(id);
  if (!a) throw new AwardActionError("Award not found");
  if (a.status === "sent" || a.status === "manual") throw new AwardActionError("Already delivered");
  tx(() => {
    // A code that was never shown to the winner goes back into the pool.
    if (a.status === "pending" || a.status === "waiting_stock") {
      db.prepare(`UPDATE prize_codes SET award_id = NULL WHERE award_id = ?`).run(id);
      db.prepare(`UPDATE awards SET code_id = NULL WHERE id = ?`).run(id);
    }
    db.prepare(`UPDATE awards SET status = 'cancelled' WHERE id = ?`).run(id);
  });
  audit(actor, "cancel prize", `${a.prizeName} for ${a.username}`);
}

export function markAwardManual(id: number, actor: string) {
  const a = getAward(id);
  if (!a) throw new AwardActionError("Award not found");
  db.prepare(`UPDATE awards SET status = 'manual', sent_at = ? WHERE id = ?`).run(Date.now(), id);
  audit(actor, "marked delivered by hand", `${a.prizeName} to ${a.username}`);
}
