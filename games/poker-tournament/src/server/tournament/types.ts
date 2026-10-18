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
  /** Fresh stack every player gets at the start of each round. */
  startingStack: number;
  /** Always 6: each table's winner advances, six tables feed one table in the next round. */
  tableSize: number;
  /** A power of 6 (6, 36, 216 or 1296) so the bracket collapses evenly to one final table. */
  maxPlayers: number;
  /** Blind structure. Every table starts again at level 1 when it begins. */
  levels: Level[];
  /** A break follows every N levels at each table. 0 disables breaks. */
  breakEveryLevels: number;
  breakMinutes: number;
  decisionSeconds: number;
  timeBankSeconds: number;
  /** Added to every player's time bank at each new level, up to timeBankSeconds. */
  timeBankRefillSeconds: number;
  /** Percent of the field that finishes in the money. */
  payoutPercent: number;
  /**
   * What table winners take to their next table.
   * "fair" (Fair Play): everyone starts every table with the starting stack.
   * "bully" (Full-on Bullying): winners keep every chip they won.
   * Missing on tournaments saved before this setting existed, which played Fair Play.
   */
  chipMode?: ChipMode;
}

export type ChipMode = "fair" | "bully";

export type TournamentStatus = "registering" | "running" | "finished" | "cancelled";

export interface Entrant {
  userId: number;
  username: string;
  avatarUrl: string;
  registeredAt: number;
  /** Table the player sits at, or null (before the start, between rounds, after busting). */
  tableId: number | null;
  /** Round the player is in, or was knocked out in. 0 before the start. */
  round: number;
  /** After winning a table: the next-round table they're waiting for. */
  advancedTo: number | null;
  place: number | null;
  points: number;
  /** Chips they won their last table with (used by Full-on Bullying when they sit at the next table). */
  carryChips?: number;
}

/**
 * One table in the bracket. Round 1 tables are filled at the start; a later table is created once
 * all of its child tables have produced a winner.
 */
export interface BracketNode {
  /** Also the table id. */
  id: number;
  round: number;
  parent: number | null;
  children: number[];
  /** Round 1: players drawn to this table. Later rounds: winners who have arrived so far. */
  players: number[];
  done: boolean;
  winner: number | null;
}

/** Finishing places for one round's eliminations: they take the places from `worst` upward. */
export interface RoundBlock {
  worst: number;
  eliminated: number;
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
  /** Keyed by user id. */
  entrants: Record<string, Entrant>;
  /** Players not yet knocked out (seated or waiting for their next table). */
  remaining: number;
  /** Indexed by node id. Empty until the start. */
  bracket: BracketNode[];
  totalRounds: number;
  /** Index = round - 1. */
  roundBlocks: RoundBlock[];
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
  round: number;
  seats: (SeatPlayer | null)[];
  /** Each table runs its own blind clock, starting at level 1. */
  clock: Clock;
  /** Seat of the button in the last hand, or -1 before the first hand. */
  button: number;
  hand: HandState | null;
  handNo: number;
  /** When the current player's turn began (epoch ms). */
  actionStartedAt: number | null;
  /** After a hand completes, the result is shown until this time before the next hand. */
  handDoneAt: number | null;
}
