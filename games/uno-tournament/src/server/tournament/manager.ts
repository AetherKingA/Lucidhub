import type { TournamentDetail, TournamentSummary } from "../../shared/protocol.ts";
import { usersSharingIp } from "../db.ts";
import { notifyHubEventChanged, notifyHubEventFinished } from "../integration.ts";
import { insertTournament, loadTournaments, saveBatch, saveResult } from "./store.ts";
import { MAX_PLAYERS, TABLE_SIZES, WINS_TO_ADVANCE, defaultConfig } from "./structure.ts";
import { Tournament, type TournamentHooks } from "./tournament.ts";
import type { TournamentConfig } from "./types.ts";

/** What the manager needs from the realtime layer. */
export interface Notifier {
  isConnected(userId: number): boolean;
  tableChanged(tournamentId: number, tableId: number): void;
  tableClosed(tournamentId: number, tableId: number): void;
  lobbyChanged(): void;
  playerMoved(tournamentId: number, userId: number, tableId: number): void;
  playerAdvanced(tournamentId: number, userId: number, round: number, totalRounds: number): void;
  playerFinished(tournamentId: number, userId: number, place: number): void;
  /** Hand results and UNO catches, for the table chat. */
  tableNews(tournamentId: number, tableId: number, lines: string[]): void;
}

/** Admin-facing options for creating a tournament. Everything else uses the defaults. */
export interface CreateOptions {
  name: string;
  startTime: number;
  /** "closed": players ask to join and an admin approves each one. */
  access?: string;
  maxPlayers?: number;
  tableSize?: number;
  winsToAdvance?: number;
  /** "on" / true turns on stacking Draw Two and Wild Draw Four. */
  stacking?: string | boolean;
  decisionSeconds?: number;
  timeBankSeconds?: number;
}

const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const pick = <T extends number>(allowed: readonly T[], v: unknown, fallback: T): T => (allowed.includes(Number(v) as T) ? (Number(v) as T) : fallback);

const TICK_MS = 250;
const FLUSH_MS = 200;
/** Finished tournaments stay in the lobby this long. */
const KEEP_FINISHED_MS = 24 * 3_600_000;

export class TournamentManager {
  tournaments = new Map<number, Tournament>();
  private notifier: Notifier;
  private dirtyMeta = new Set<number>();
  private dirtyTables = new Map<string, { tournamentId: number; tableId: number; deleted: boolean }>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(notifier: Notifier) {
    this.notifier = notifier;
  }

  /** Loads saved tournaments. Ones that were running come back paused until an admin resumes them. */
  load(now: number) {
    for (const { meta, tables } of loadTournaments(now)) {
      const t = new Tournament(meta, new Map(tables.map((tb) => [tb.id, tb])), this.hooksFor(meta.id));
      t.restoreAfterRestart();
      this.tournaments.set(meta.id, t);
      if (meta.status === "running") console.log(`[tournament] Restored "${meta.config.name}" (paused, ${meta.remaining} players left)`);
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

  /** Has the site open right now. */
  isOnline(userId: number) {
    return this.notifier.isConnected(userId);
  }

  create(opts: CreateOptions, now: number): Tournament {
    const base = defaultConfig();
    const config: TournamentConfig = {
      name: String(opts.name || "Uno Night").slice(0, 60),
      startTime: clamp(opts.startTime, now, now + 365 * 86_400_000, now + 30 * 60_000),
      maxPlayers: clamp(opts.maxPlayers, 2, MAX_PLAYERS, base.maxPlayers),
      tableSize: pick(TABLE_SIZES, opts.tableSize, 4),
      winsToAdvance: pick(WINS_TO_ADVANCE, opts.winsToAdvance, 2),
      stacking: opts.stacking === true || opts.stacking === "on",
      decisionSeconds: clamp(opts.decisionSeconds, 5, 60, base.decisionSeconds),
      timeBankSeconds: clamp(opts.timeBankSeconds, 0, 300, base.timeBankSeconds),
    };
    const id = insertTournament(now);
    const t = Tournament.create(id, config, now, this.hooksFor(id));
    if (opts.access === "closed") t.meta.access = "closed";
    this.tournaments.set(id, t);
    this.dirtyMeta.add(id);
    this.scheduleFlush();
    this.notifier.lobbyChanged();
    console.log(`[tournament] Created "${config.name}" starting ${new Date(config.startTime).toLocaleString()}`);
    return t;
  }

  list(viewerId: number | null): TournamentSummary[] {
    return [...this.tournaments.values()].map((t) => t.summary(viewerId)).sort((a, b) => a.startTime - b.startTime);
  }

  detail(id: number, viewerId: number | null): TournamentDetail | null {
    return this.tournaments.get(id)?.detail(viewerId) ?? null;
  }

  /** Pairs of players sitting at the same table who have logged in from the same IP. */
  ipFlags(id: number) {
    const t = this.tournaments.get(id);
    if (!t) return [];
    const flags: { tableId: number; players: { userId: number; username: string }[] }[] = [];
    for (const table of t.tables.values()) {
      const here = new Set(table.seats.flatMap((s) => (s ? [s.userId] : [])));
      const seen = new Set<string>();
      for (const userId of here) {
        for (const other of usersSharingIp(userId)) {
          if (!here.has(other)) continue;
          const key = [userId, other].sort().join("-");
          if (seen.has(key)) continue;
          seen.add(key);
          flags.push({
            tableId: table.id,
            players: [userId, other].map((u) => ({ userId: u, username: t.meta.entrants[u]?.username ?? "?" })),
          });
        }
      }
    }
    return flags;
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
      const ended = t.meta.status === "finished" || t.meta.status === "cancelled";
      if (ended && now - (t.meta.finishedAt ?? now) > KEEP_FINISHED_MS) {
        this.tournaments.delete(t.id);
        this.notifier.lobbyChanged();
      }
    }
  }

  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const now = Date.now();
    const metas = [...this.dirtyMeta].flatMap((id) => {
      const t = this.tournaments.get(id);
      if (!t) return [];
      t.meta.savedAt = now;
      return [t.meta];
    });
    const tables = [...this.dirtyTables.values()].map(({ tournamentId, tableId, deleted }) => ({
      tournamentId,
      tableId,
      state: deleted ? null : (this.tournaments.get(tournamentId)?.tables.get(tableId) ?? null),
    }));
    this.dirtyMeta.clear();
    this.dirtyTables.clear();
    try {
      saveBatch({ metas, tables }, now);
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
      isConnected: (userId) => n.isConnected(userId),
      tableChanged: (tableId) => n.tableChanged(tournamentId, tableId),
      tableClosed: (tableId) => n.tableClosed(tournamentId, tableId),
      lobbyChanged: () => {
        n.lobbyChanged();
        // Keeps the hub's player counts and lobby panel live.
        notifyHubEventChanged(tournamentId);
      },
      playerMoved: (userId, tableId) => n.playerMoved(tournamentId, userId, tableId),
      playerAdvanced: (userId, round) => n.playerAdvanced(tournamentId, userId, round, this.tournaments.get(tournamentId)?.meta.totalRounds ?? round),
      playerFinished: (userId, place) => {
        saveResult(tournamentId, userId, place);
        n.playerFinished(tournamentId, userId, place);
      },
      tableNews: (tableId, lines) => n.tableNews(tournamentId, tableId, lines),
      tournamentFinished: () => {
        // Save first so the hub finds the final status and results when it calls back.
        this.flush();
        notifyHubEventFinished(tournamentId);
      },
      dirty: (what) => {
        if (what === "meta") this.dirtyMeta.add(tournamentId);
        else this.dirtyTables.set(`${tournamentId}:${what.tableId}`, { tournamentId, tableId: what.tableId, deleted: Boolean(what.deleted) });
        this.scheduleFlush();
      },
    };
  }
}
