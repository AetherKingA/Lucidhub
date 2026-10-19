// Messages exchanged over the WebSocket, and the views the server sends. Shared by server and client
// so both stay in sync.

import type { Color } from "./engine/chess.ts";

export type { Color };

export interface UserInfo {
  id: number;
  username: string;
  avatarUrl: string;
  isAdmin: boolean;
}

export interface TournamentSummary {
  id: number;
  name: string;
  status: "registering" | "running" | "finished" | "cancelled";
  paused: boolean;
  pauseReason: string | null;
  startTime: number;
  entrants: number;
  remaining: number;
  maxPlayers: number;
  winsToAdvance: number;
  minutes: number;
  incrementSeconds: number;
  /** Earliest round still being played (1-based). Before the start: 1. */
  round: number;
  /** Rounds in the bracket (projected from current registrations before the start). */
  totalRounds: number;
  activeTables: number;
  registrationOpen: boolean;
  /** "closed": registering sends a join request that an admin approves. */
  access: "open" | "closed";
  me: {
    registered: boolean;
    /** Asked to join a closed lobby; waiting for an admin. */
    pending: boolean;
    /** An admin removed them from this tournament. */
    removed: boolean;
    tableId: number | null;
    place: number | null;
    round: number;
    /** Set after winning a match (or getting a bye), while the other feeder match finishes. */
    waiting: { round: number; tableId: number; groupDone: number; groupSize: number } | null;
  } | null;
}

export interface SeatView {
  seat: number;
  userId: number;
  username: string;
  avatarUrl: string;
  /** Color in the current (or last) game. */
  color: Color | null;
  /** Games won in this match. */
  wins: number;
  draws: number;
  connected: boolean;
}

export interface TableView {
  tournamentId: number;
  tableId: number;
  seats: (SeatView | null)[];
  gameNo: number;
  /** 64 squares, a1 = 0 … h8 = 63, FEN letters ("" = empty). Empty array between games. */
  board: string[];
  turn: Color;
  /** Moves so far, SAN. */
  moves: string[];
  /** The last move, for highlighting. */
  lastMove: { from: number; to: number } | null;
  /** Square of the king in check, if any. */
  checkSquare: number | null;
  /** Time left for each side at the start of the current turn. */
  clocks: Record<Color, number>;
  /** When the current turn began; the side to move's clock runs from here. Null when nobody's clock runs. */
  turnStartedAt: number | null;
  /** While a side hasn't made their first move: they must move by this time. */
  firstMoveDeadline: number | null;
  minutes: number;
  incrementSeconds: number;
  armageddon: boolean;
  /** Seat offering a draw. */
  drawOfferSeat: number | null;
  /** After a game ends, until the next one starts. armageddon: a draw that counted as a win for Black. */
  result: { winnerSeat: number | null; reason: string; armageddon: boolean } | null;
  round: number;
  totalRounds: number;
  winsToAdvance: number;
  mySeat: number | null;
  myColor: Color | null;
  /** UCI moves the viewer may play right now (empty unless it's their turn). */
  legal: string[];
  paused: boolean;
  serverNow: number;
}

export interface TournamentDetail {
  summary: TournamentSummary;
  rounds: { round: number; tables: number; done: number; players: number }[];
  tables: { id: number; round: number; players: string[]; score: string; gameNo: number; viewers: number }[];
  /** Players still in (furthest round first, then game wins), then knocked-out players by place. */
  standings: { userId: number; username: string; round: number; wins: number; place: number | null; tableId: number | null }[];
}

// ---- Spectating. This block is the same in all three games (poker, Uno, chess).

/** "table": the players' chat (spectators read it). "spectators": only people watching see it. */
export type ChatChannel = "table" | "spectators";

/** A spectator following one player through the tournament. */
export interface FollowInfo {
  userId: number;
  username: string;
  /** Their board now; null while they wait for their next match. */
  tableId: number | null;
  round: number;
}

export interface ChatMessage {
  id: number;
  /**
   * player = seated at this board, spectator = watching, host = an admin who isn't playing here,
   * dealer = game results and match news.
   */
  kind: "player" | "spectator" | "host" | "dealer";
  userId: number | null;
  username: string;
  avatarUrl: string | null;
  admin: boolean;
  text: string;
  at: number;
}

export type ServerMessage =
  | { type: "hello"; user: UserInfo; online: number; serverNow: number }
  | { type: "online"; count: number }
  | { type: "pong"; t: number; serverNow: number }
  | { type: "error"; message: string }
  | { type: "lobby"; tournaments: TournamentSummary[]; serverNow: number }
  | { type: "table"; view: TableView }
  | { type: "tableClosed"; tournamentId: number; tableId: number }
  | { type: "moved"; tournamentId: number; tableId: number }
  | { type: "finished"; tournamentId: number; place: number }
  | { type: "advanced"; tournamentId: number; round: number; totalRounds: number; bye: boolean }
  /** replace: the board's whole recent history (sent when you start watching); otherwise new messages. */
  | { type: "chat"; tournamentId: number; tableId: number; channel: ChatChannel; messages: ChatMessage[]; replace: boolean }
  /** How many people (not playing there) are watching a board. */
  | { type: "viewers"; tournamentId: number; tableId: number; count: number }
  /** Who you're following in a tournament (null: nobody), with an optional note about what just happened. */
  | { type: "follow"; tournamentId: number; following: FollowInfo | null; notice: string | null };

export type ClientMessage =
  | { type: "ping"; t: number }
  | { type: "register"; tournamentId: number }
  | { type: "unregister"; tournamentId: number }
  /** Start receiving updates for a board (null to stop). Players are always sent their own board. */
  | { type: "watch"; tournamentId: number; tableId: number | null }
  | { type: "action"; tournamentId: number; action: ClientAction }
  /** Say something at a board you're seated at or watching. No channel: table if playing there, else spectators. */
  | { type: "chat"; tournamentId: number; tableId: number; channel?: ChatChannel; text: string }
  /** Follow a player to each board they play at (null to stop). Spectators only. */
  | { type: "follow"; tournamentId: number; userId: number | null };

export type ClientAction =
  | { type: "move"; uci: string }
  | { type: "resign" }
  /** Offer a draw, or accept the opponent's offer. */
  | { type: "draw" }
  | { type: "declineDraw" };
