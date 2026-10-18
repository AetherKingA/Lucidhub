// Things you should know about without opening the dashboard: low stock, failed DMs, a game going offline.
// Each alert is written to the audit log and, once the bot is online, posted to the alerts channel
// (or DM'd to the admins if no channel is set). Repeats of the same alert within an hour are dropped.

import { audit } from "./db.ts";

type Sink = (message: string) => Promise<void>;

let sink: Sink | null = null;
const lastSent = new Map<string, number>();
const REPEAT_MS = 3_600_000;

export function setAlertSink(fn: Sink | null) {
  sink = fn;
}

export function raiseAlert(key: string, message: string) {
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < REPEAT_MS) return;
  lastSent.set(key, now);
  audit("system", "alert", message);
  sink?.(message).catch((err) => console.warn("[alerts] Could not send alert:", (err as Error).message));
}
