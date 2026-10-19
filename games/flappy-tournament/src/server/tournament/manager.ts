import { randomInt } from "node:crypto";
import type { TournamentSummary, TournamentView } from "../../shared/protocol.ts";
import { notifyHubEventChanged, notifyHubEventFinished } from "../integration.ts";
import { insertTournament, loadTournaments, saveMetas, saveResults } from "./store.ts";
import { Tournament, type TournamentHooks } from "./tournament.ts";
import type { TournamentConfig } from "./types.ts";

/** What the manager needs from the realtime layer. */
export interface Notifier {
  isConnected(userId: number): boolean;
  lobbyChanged(): void;
  tournamentChanged(tournamentId: number): void;
}

/** Admin-facing options for creating a tournament (the hub's "New event" form). */
export interface CreateOptions {
  name: string;
  startTime: number;
  /** "closed": players ask to join and an admin approves each one. */
  access?: string;
  maxPlayers?: number;
  durationMinutes?: number;
}

export const MAX_PLAYERS = 200;
export const MIN_DURATION = 1;
export const MAX_DURATION = 30;
export const DEFAULT_DURATION = 5;
export const DEFAULT_MAX_PLAYERS = 50;

const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return v !== undefined && v !== "" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const TICK_MS = 250;
const FLUSH_MS = 200;
/** Finished tournaments stay in the lobby this long. */
const KEEP_FINISHED_MS = 24 * 3_600_000;

export class TournamentManager {
  tournaments = new Map<number, Tournament>();
  private notifier: Notifier;
  private dirty = new Set<number>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(notifier: Notifier) {
    this.notifier = notifier;
  }

  /** Loads saved tournaments. Running ones come back paused until an admin resumes them. */
  load(now: number) {
    for (const meta of loadTournaments(now)) {
      const t = new Tournament(meta, this.hooksFor(meta.id));
      this.tournaments.set(meta.id, t);
      t.restoreAfterRestart(now);
      if (meta.status === "running") console.log(`[tournament] Restored "${meta.config.name}" (paused)`);
    }
  }

  start() {
    this.tickTimer = setInterval(() => this.tick(Date.now()), TICK_MS);
  }

  /** Stops the clock and writes everything to disk. */
  stop() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.flush();
  }

  get(id: number) {
    return this.tournaments.get(id);
  }

  isOnline(userId: number) {
    return this.notifier.isConnected(userId);
  }

  create(opts: CreateOptions, now: number): Tournament {
    const config: TournamentConfig = {
      name: String(opts.name || "Flappy Night").slice(0, 60),
      startTime: clamp(opts.startTime, now, now + 365 * 86_400_000, now + 30 * 60_000),
      maxPlayers: clamp(opts.maxPlayers, 2, MAX_PLAYERS, DEFAULT_MAX_PLAYERS),
      durationMinutes: clamp(opts.durationMinutes, MIN_DURATION, MAX_DURATION, DEFAULT_DURATION),
    };
    const id = insertTournament(now);
    const t = Tournament.create(id, config, randomInt(1, 2 ** 31), now, this.hooksFor(id));
    if (opts.access === "closed") t.meta.access = "closed";
    this.tournaments.set(id, t);
    this.dirty.add(id);
    this.scheduleFlush();
    this.notifier.lobbyChanged();
    console.log(`[tournament] Created "${config.name}" (${config.durationMinutes} min) starting ${new Date(config.startTime).toLocaleString()}`);
    return t;
  }

  list(viewerId: number | null, now: number): TournamentSummary[] {
    return [...this.tournaments.values()].map((t) => t.summary(viewerId, now)).sort((a, b) => a.startTime - b.startTime);
  }

  view(id: number, viewerId: number | null, now: number): TournamentView | null {
    return this.tournaments.get(id)?.view(viewerId, now) ?? null;
  }

  tick(now: number) {
    for (const t of this.tournaments.values()) {
      try {
        t.tick(now);
      } catch (err) {
        // Never let one bug take down the server: pause the tournament so an admin can look.
        console.error(`[tournament] Error in "${t.config.name}":`, err);
        if (t.meta.status === "running" && !t.meta.paused) t.pause("Paused after a server error. An admin can resume it.", now);
      }
      if (t.isOver() && now - (t.meta.finishedAt ?? now) > KEEP_FINISHED_MS) {
        this.tournaments.delete(t.id);
        this.notifier.lobbyChanged();
      }
    }
  }

  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const now = Date.now();
    const metas = [...this.dirty].flatMap((id) => {
      const t = this.tournaments.get(id);
      if (!t) return [];
      t.meta.savedAt = now;
      return [t.meta];
    });
    this.dirty.clear();
    try {
      saveMetas(metas, now);
    } catch (err) {
      console.error("[tournament] Failed to save:", err);
    }
  }

  private scheduleFlush() {
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  private hooksFor(tournamentId: number): TournamentHooks {
    const n = this.notifier;
    return {
      lobbyChanged: () => {
        n.lobbyChanged();
        // Keeps the hub's player counts and lobby panel live.
        notifyHubEventChanged(tournamentId);
      },
      changed: () => n.tournamentChanged(tournamentId),
      tournamentFinished: (rows) => {
        // Save first so the hub finds the final status and results when it calls back.
        saveResults(tournamentId, rows);
        this.dirty.add(tournamentId);
        this.flush();
        notifyHubEventFinished(tournamentId);
      },
      dirty: () => {
        this.dirty.add(tournamentId);
        this.scheduleFlush();
      },
    };
  }
}
