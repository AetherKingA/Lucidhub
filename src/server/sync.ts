// Keeps the hub's copy of every game's events current and hands out prizes when one ends.
// A game's webhook triggers this instantly; the 2-minute reconcile is the safety net for missed
// webhooks, a hub restart, or a game that was offline when its event finished.

import { raiseAlert } from "./alerts.ts";
import { awardEvent } from "./awards.ts";
import { listEvents, upsertEvent, unprocessedEnded } from "./events.ts";
import { type Game, gameClient, getGame, listGames } from "./games.ts";

/** How far back to ask games for events. */
const LOOKBACK_MS = 7 * 86_400_000;

const offline = new Set<number>();
const syncing = new Map<number, Promise<void>>();
/** Games that changed again while a sync was under way: they sync once more when it ends, so the latest change isn't missed. */
const again = new Set<number>();

/** Syncs one game's events, then awards any of its events that ended. */
export function syncGame(game: Game): Promise<void> {
  const existing = syncing.get(game.id);
  if (existing) {
    again.add(game.id);
    return existing;
  }
  const p = (async () => {
    try {
      const events = await gameClient.listEvents(game, Date.now() - LOOKBACK_MS);
      for (const e of events) upsertEvent(game.id, e);
      if (offline.delete(game.id)) console.log(`[sync] ${game.name} is back online`);
    } catch (err) {
      if (!offline.has(game.id)) {
        offline.add(game.id);
        raiseAlert(`offline:${game.id}`, `**${game.name}** isn't answering (${(err as Error).message}). Prizes for its events will go out once it's back.`);
      }
      return;
    }
    for (const ev of unprocessedEnded().filter((e) => e.gameId === game.id)) {
      try {
        await awardEvent(ev.id);
      } catch (err) {
        console.warn(`[sync] Could not award event ${ev.id}:`, (err as Error).message);
      }
    }
  })().finally(() => {
    syncing.delete(game.id);
    if (again.delete(game.id)) void syncGame(game);
  });
  syncing.set(game.id, p);
  return p;
}

export async function syncAll() {
  await Promise.all(listGames().filter((g) => g.enabled).map((g) => syncGame(g)));
}

/** Syncs just the games with an event open or under way, so player counts stay current even if a webhook is missed. */
export async function syncLive() {
  const live = new Set([...listEvents({ status: "registering" }), ...listEvents({ status: "running" })].map((e) => e.gameId));
  await Promise.all(listGames().filter((g) => g.enabled && live.has(g.id)).map((g) => syncGame(g)));
}

export function syncGameById(id: number) {
  const g = getGame(id);
  return g ? syncGame(g) : Promise.resolve();
}
