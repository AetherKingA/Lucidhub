import type { HandState } from "../../shared/engine/hand.ts";

export interface Level {
  smallBlind: number;
  bigBlind: number;
  ante: number;
  minutes: number;
}

export interface TournamentConfig {
  name: string;
  /** Epoch ms. The tournament starts automatically at this time if at least two players registered. */
  startTime: number;
  startingStack: number;
  tableSize: number;
  maxPlayers: number;
  levels: Level[];
  /** Registration stays open until this many levels have been played. */
  lateRegLevels: number;
  /** A break follows every N levels. 0 disables breaks. */
  breakEveryLevels: number;
  breakMinutes: number;
  decisionSeconds: number;
  timeBankSeconds: number;
  /** Added to every player's time bank at each new level, up to timeBankSeconds. */
  timeBankRefillSeconds: number;
  /** Percent of the field that finishes in the money. */
  payoutPercent: number;
}

export type TournamentStatus = "registering" | "running" | "finished" | "cancelled";

export interface Entrant {
  userId: number;
  username: string;
  avatarUrl: string;
  registeredAt: number;
  /** Table the player sits at, or null before the start and after busting. */
  tableId: number | null;
  place: number | null;
  points: number;
}

export interface Clock {
  phase: "level" | "break";
  level: number;
  /** When the current phase ends (epoch ms), or null on the final level. Ignored while paused. */
  endsAt: number | null;
}

/** Everything about a tournament except its tables. Saved as one JSON row. */
export interface TournamentMeta {
  id: number;
  config: TournamentConfig;
  status: TournamentStatus;
  paused: boolean;
  pauseReason: string | null;
  /** When the pause began; timers resume from where they were at this moment. */
  pausedAt: number | null;
  clock: Clock;
  /** Keyed by user id. */
  entrants: Record<string, Entrant>;
  /** Players still seated (not busted). */
  remaining: number;
  nextTableId: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Last time this was written to disk; used as the pause point after a crash. */
  savedAt: number;
}

export interface SeatPlayer {
  userId: number;
  chips: number;
  /** Timed out or chose to sit out: acted for automatically (check or fold) until they return. */
  away: boolean;
  /** Kicked by an admin: folds every hand and is removed when the current hand ends. */
  leaving: boolean;
  timeBankMs: number;
}

/** One table. Saved as its own JSON row so an action only rewrites ~5 KB. */
export interface TableState {
  id: number;
  seats: (SeatPlayer | null)[];
  /** Seat of the button in the last hand, or -1 before the first hand. */
  button: number;
  hand: HandState | null;
  handNo: number;
  /** When the current player's turn began (epoch ms). */
  actionStartedAt: number | null;
  /** After a hand completes, the result is shown until this time before the next hand. */
  handDoneAt: number | null;
}
