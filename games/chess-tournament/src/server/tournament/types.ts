import type { ChessState, Color } from "../../shared/engine/chess.ts";

export interface TournamentConfig {
  name: string;
  /** Epoch ms. The tournament starts automatically at this time if at least two players registered. */
  startTime: number;
  maxPlayers: number;
  /** Games a player must win to win a match (draws don't count). */
  winsToAdvance: number;
  /** Clock per player per game. */
  minutes: number;
  /** Seconds added to a player's clock after each of their moves. */
  incrementSeconds: number;
}

export type TournamentStatus = "registering" | "running" | "finished" | "cancelled";

export interface Entrant {
  userId: number;
  username: string;
  avatarUrl: string;
  registeredAt: number;
  /** Board the player sits at, or null (before the start, between rounds, after being knocked out). */
  tableId: number | null;
  /** Round the player is in, or was knocked out in. 0 before the start. */
  round: number;
  /** After winning a match (or a bye): the next-round board they're waiting for. */
  advancedTo: number | null;
  place: number | null;
}

/**
 * One match in the bracket. Round 1 matches are filled at the start; a later match is played once
 * both of its feeder matches have produced a winner.
 */
export interface BracketNode {
  /** Also the board (table) id. */
  id: number;
  round: number;
  parent: number | null;
  children: number[];
  /** Round 1: players drawn to this match (one = a bye). Later rounds: winners who have arrived so far. */
  players: number[];
  done: boolean;
  winner: number | null;
}

/** Finishing places for one round's knockouts: they take the places from `worst` upward. */
export interface RoundBlock {
  worst: number;
  eliminated: number;
}

/** Everything about a tournament except its boards. Saved as one JSON row. */
export interface TournamentMeta {
  id: number;
  config: TournamentConfig;
  status: TournamentStatus;
  paused: boolean;
  pauseReason: string | null;
  /** When the pause began; clocks resume from where they were at this moment. */
  pausedAt: number | null;
  /** Keyed by user id. */
  entrants: Record<string, Entrant>;
  /** Players not yet knocked out (seated or waiting for their next match). */
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
  /** Games won in this match. */
  wins: number;
  /** Games drawn in this match. */
  draws: number;
}

export type GameEndReason =
  | "checkmate"
  | "stalemate"
  | "repetition"
  | "fifty-move"
  | "insufficient"
  | "resign"
  | "timeout"
  | "timeout-draw"
  | "agreement"
  | "no-move"
  | "removed";

/** One game of a match. */
export interface MatchGame {
  chess: ChessState;
  /** User id playing each color. */
  white: number;
  black: number;
  /** Time left for each side at the start of the current turn (ms). */
  clocks: Record<Color, number>;
  /** When the current turn began (epoch ms). */
  turnStartedAt: number;
  /** Armageddon: a draw counts as a win for Black. */
  armageddon: boolean;
  /** User id of a player offering a draw, until the other answers or moves. */
  drawOffer: number | null;
  /** Set when the game ends. winner null = draw; armageddon = a draw that went to Black. */
  result: { winner: number | null; reason: GameEndReason; armageddon?: boolean } | null;
}

/** One board: a best-of match between two players. Saved as its own JSON row so a move only rewrites that board. */
export interface TableState {
  id: number;
  round: number;
  /** Always two seats. */
  seats: (SeatPlayer | null)[];
  game: MatchGame | null;
  gameNo: number;
  /** Who had White in the last game, so colors alternate. Null before the first game. */
  lastWhite: number | null;
  /** Draws in a row; after two, the next game is Armageddon. */
  drawStreak: number;
  /** After a game ends, the result is shown until this time before the next game. */
  gameDoneAt: number | null;
}
