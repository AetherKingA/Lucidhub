import type { GameState } from "../../shared/engine/game.ts";

export interface TournamentConfig {
  name: string;
  /** Epoch ms. The tournament starts automatically at this time if at least two players registered. */
  startTime: number;
  maxPlayers: number;
  /** Players per table (3–6). Each table's winner advances; `tableSize` tables feed one in the next round. */
  tableSize: number;
  /** Hands a player must win at a table to win the table. */
  winsToAdvance: number;
  /** House rule: pass a Draw Two / Wild Draw Four penalty on with another draw card. */
  stacking: boolean;
  decisionSeconds: number;
  /** Extra thinking time per table, used up once the decision time runs out. */
  timeBankSeconds: number;
}

export type TournamentStatus = "registering" | "running" | "finished" | "cancelled";

/** "open": anyone can register. "closed": players ask to join and an admin lets each one in. */
export type LobbyAccess = "open" | "closed";

/** Someone who asked to join a closed lobby. */
export interface PendingEntrant {
  userId: number;
  username: string;
  avatarUrl: string;
  requestedAt: number;
}

export interface Entrant {
  userId: number;
  username: string;
  avatarUrl: string;
  registeredAt: number;
  /** Table the player sits at, or null (before the start, between rounds, after being knocked out). */
  tableId: number | null;
  /** Round the player is in, or was knocked out in. 0 before the start. */
  round: number;
  /** After winning a table: the next-round table they're waiting for. */
  advancedTo: number | null;
  place: number | null;
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

/** Finishing places for one round's knockouts: they take the places from `worst` upward. */
export interface RoundBlock {
  worst: number;
  eliminated: number;
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
  /** Missing on tournaments saved before lobbies could be closed: those are open. */
  access?: LobbyAccess;
  /** Join requests waiting for an admin (closed lobbies), keyed by user id. */
  pending?: Record<string, PendingEntrant>;
  /** Players an admin removed. They can't register again, and leave their next table as soon as they reach it. */
  kicked?: number[];
  /** Players not yet knocked out (seated or waiting for their next table). */
  remaining: number;
  /** Indexed by node id - 1. Empty until the start. */
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
  /** Hands won at this table. */
  wins: number;
  /** Card points left in their hand, added up over every hand they lost here (lower is better). */
  points: number;
  /** Timed out: played for automatically until they act again. */
  away: boolean;
  timeBankMs: number;
}

/** One table. Saved as its own JSON row so an action only rewrites that table. */
export interface TableState {
  id: number;
  round: number;
  seats: (SeatPlayer | null)[];
  /** Seat of the dealer in the last hand, or -1 before the first hand. */
  dealer: number;
  game: GameState | null;
  handNo: number;
  /** When the current player's turn began (epoch ms). */
  actionStartedAt: number | null;
  /** After a hand ends, the result is shown until this time before the next hand. */
  handDoneAt: number | null;
  /** Card points each player was left holding in the last finished hand, by user id (for the result banner). */
  lastResult: { winner: number; points: Record<string, number> } | null;
}
