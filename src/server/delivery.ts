// Sends pending awards to winners by DM and posts the winners announcement. Runs every few seconds;
// everything it needs is in the database, so a restart picks up exactly where it left off.

import { raiseAlert } from "./alerts.ts";
import { renderAward } from "./awards.ts";
import { audit, db, getSettings } from "./db.ts";
import { getEvent, markAnnounced, unannounced } from "./events.ts";

/** The winner has DMs from server members turned off, or blocked the bot. Retrying won't help. */
export class DmClosedError extends Error {}

/** What the delivery worker needs from Discord. The bot implements it; tests use a fake. */
export interface Messenger {
  ready(): boolean;
  sendDm(discordId: string, message: { title: string; text: string; imageUrl: string | null }): Promise<void>;
  /** Posts to a channel; mentions in the text ping those users. */
  post(channelId: string, text: string): Promise<void>;
}

const MAX_ATTEMPTS = 8;
const BATCH = 20;
const backoffMs = (attempts: number) => Math.min(3_600_000, 30_000 * 2 ** (attempts - 1));

const dueStmt = db.prepare(
  `SELECT a.id, a.discord_id, a.username, a.attempts, a.event_id, p.name AS prize_name
   FROM awards a JOIN prizes p ON p.id = a.prize_id
   WHERE a.status = 'pending' AND a.next_attempt_at <= ? ORDER BY a.id LIMIT ?`,
);
const sentStmt = db.prepare(`UPDATE awards SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?`);
const failStmt = db.prepare(`UPDATE awards SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`);

const MEDALS = ["🥇", "🥈", "🥉"];

export class DeliveryWorker {
  private messenger: Messenger;
  private running = false;

  constructor(messenger: Messenger) {
    this.messenger = messenger;
  }

  /** One pass: send what's due, then announce finished events. Never runs twice at once. */
  async tick(now = Date.now()) {
    if (this.running || !this.messenger.ready()) return;
    this.running = true;
    try {
      await this.sendDue(now);
      await this.announce();
    } finally {
      this.running = false;
    }
  }

  private async sendDue(now: number) {
    const due = dueStmt.all(now, BATCH) as { id: number; discord_id: string; username: string; attempts: number; event_id: number; prize_name: string }[];
    for (const a of due) {
      const msg = renderAward(a.id);
      if (!msg) continue;
      try {
        await this.messenger.sendDm(a.discord_id, { title: `🏆 You won: ${msg.prizeName}`, text: msg.text, imageUrl: msg.imageUrl });
        sentStmt.run(Date.now(), a.id);
        audit("bot", "prize sent", `${a.prize_name} to ${a.username}`);
      } catch (err) {
        const attempts = a.attempts + 1;
        const closed = err instanceof DmClosedError;
        const giveUp = closed || attempts >= MAX_ATTEMPTS;
        const reason = closed ? "Their DMs are closed to the bot" : (err as Error).message.slice(0, 300);
        failStmt.run(giveUp ? "dm_failed" : "pending", attempts, Date.now() + backoffMs(attempts), reason, a.id);
        if (!giveUp) continue;
        audit("bot", "DM failed", `${a.prize_name} to ${a.username}: ${reason}`);
        raiseAlert(`dm:${a.id}`, `Couldn't DM **${a.prize_name}** to ${a.username} (${reason}). They've been told to use /prizes; you can also Resend from the dashboard.`);
        await this.nudge(a.event_id, a.discord_id);
      }
    }
  }

  /** Tells a winner whose DMs are closed where to find their prize. */
  private async nudge(eventId: number, discordId: string) {
    const channel = this.channelFor(eventId);
    if (!channel) return;
    try {
      await this.messenger.post(channel, `<@${discordId}> I couldn't DM you your prize — type **/prizes** to see it (only you will see the reply).`);
    } catch (err) {
      console.warn("[delivery] Could not post DM-failed notice:", (err as Error).message);
    }
  }

  private channelFor(eventId: number) {
    return getEvent(eventId)?.announceChannelId || getSettings().announceChannelId || null;
  }

  private async announce() {
    for (const eventId of unannounced()) {
      const ev = getEvent(eventId);
      if (!ev) continue;
      const channel = this.channelFor(eventId);
      if (!channel) {
        markAnnounced(eventId); // nowhere to post; don't keep checking
        continue;
      }
      try {
        await this.messenger.post(channel, announcementText(eventId, ev.name));
        markAnnounced(eventId);
        audit("bot", "winners announced", ev.name);
      } catch (err) {
        raiseAlert(`announce:${eventId}`, `Couldn't post the winners of **${ev.name}** in <#${channel}>: ${(err as Error).message}`);
        markAnnounced(eventId);
      }
    }
  }
}

/** "🏆 Poker Night — winners" with one line per place. Prize names only; codes are never public. */
export function announcementText(eventId: number, eventName: string) {
  const rows = db
    .prepare(
      `SELECT a.place, a.discord_id, p.name AS prize_name FROM awards a JOIN prizes p ON p.id = a.prize_id
       WHERE a.event_id = ? AND a.status != 'cancelled' ORDER BY a.place, a.id`,
    )
    .all(eventId) as { place: number; discord_id: string; prize_name: string }[];
  const byWinner = new Map<string, { place: number; discordId: string; prizes: string[] }>();
  for (const r of rows) {
    const key = `${r.place}:${r.discord_id}`;
    const entry = byWinner.get(key) ?? { place: r.place, discordId: r.discord_id, prizes: [] };
    entry.prizes.push(r.prize_name);
    byWinner.set(key, entry);
  }
  const lines = [...byWinner.values()].map((w) => `${MEDALS[w.place - 1] ?? `#${w.place}`} <@${w.discordId}> — ${w.prizes.join(" + ")}`);
  return [`🏆 **${eventName}** — winners`, ...lines, "", "Prizes have been sent by DM. Didn't get yours? Type **/prizes**."].join("\n");
}
