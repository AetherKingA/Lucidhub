// Messages exchanged over the WebSocket, and the views the server sends. Shared by server and client
// so both stay in sync.

import type { Action, LegalActions, Street } from "./engine/hand.ts";

export type { Action, LegalActions };

export interface UserInfo {
  id: number;
  username: string;
  avatarUrl: string;
  isAdmin: boolean;
}

export interface LevelInfo {
  smallBlind: number;
  bigBlind: number;
  ante: number;
  minutes: number;
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
  startingStack: number;
  /** Earliest round still being played (1-based). Before the start: 1. */
  round: number;
  /** Rounds in the bracket (projected from current registrations before the start). */
  totalRounds: number;
  activeTables: number;
  registrationOpen: boolean;
  firstLevel: LevelInfo;
  me: {
    registered: boolean;
    tableId: number | null;
    place: number | null;
    points: number;
    round: number;
    /** Set after winning a table, while the rest of the group finishes. */
    waiting: { round: number; tableId: number; groupDone: number; groupSize: number } | null;
  } | null;
}

export interface SeatView {
  seat: number;
  userId: number;
  username: string;
  avatarUrl: string;
  /** Chips behind (not counting the current bet). */
  chips: number;
  bet: number;
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  away: boolean;
  connected: boolean;
  /** "??" for hidden cards. Empty when not dealt in. */
  holeCards: string[];
  lastAction: string | null;
  /** Set when the hand is over. */
  won: number;
  handName: string | null;
  timeBankMs: number;
}

export interface TableView {
  tournamentId: number;
  tableId: number;
  tableSize: number;
  seats: (SeatView | null)[];
  button: number;
  handNo: number;
  street: Street | null;
  board: string[];
  /** Chips in the middle, not counting bets in front of players this street. */
  pot: number;
  currentBet: number;
  toActSeat: number | null;
  actionStartedAt: number | null;
  decisionMs: number;
  /** When the acting player times out (including their time bank). */
  actionDeadline: number | null;
  round: number;
  totalRounds: number;
  /** This table's own blind clock. */
  phase: "level" | "break";
  levelIndex: number;
  level: LevelInfo;
  nextLevel: LevelInfo | null;
  /** When the current level/break ends, or null (paused or final level). */
  phaseEndsAt: number | null;
  phaseRemainingMs: number | null;
  /** Present only for the viewer whose turn it is. */
  legal: LegalActions | null;
  mySeat: number | null;
  handComplete: boolean;
  paused: boolean;
  onBreak: boolean;
  serverNow: number;
}

export interface TournamentDetail {
  summary: TournamentSummary;
  levels: LevelInfo[];
  breakEveryLevels: number;
  breakMinutes: number;
  payouts: { place: number; percent: number; points: number }[];
  rounds: { round: number; tables: number; done: number; players: number }[];
  tables: { id: number; round: number; players: number; handNo: number }[];
  /** Players still in (furthest round first, then chips), then knocked-out players by place. */
  standings: { userId: number; username: string; round: number; chips: number; place: number | null; points: number; tableId: number | null }[];
}

export interface ChatMessage {
  id: number;
  /** player = seated at this table, spectator = watching, dealer = hand results and table news. */
  kind: "player" | "spectator" | "dealer";
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
  | { type: "finished"; tournamentId: number; place: number; points: number }
  | { type: "advanced"; tournamentId: number; round: number; totalRounds: number }
  /** replace: the table's whole recent history (sent when you start watching); otherwise new messages. */
  | { type: "chat"; tournamentId: number; tableId: number; messages: ChatMessage[]; replace: boolean };

export type ClientMessage =
  | { type: "ping"; t: number }
  | { type: "register"; tournamentId: number }
  | { type: "unregister"; tournamentId: number }
  /** Start receiving updates for a table (null to stop). Players are always sent their own table. */
  | { type: "watch"; tournamentId: number; tableId: number | null }
  | { type: "action"; tournamentId: number; action: Action }
  | { type: "back"; tournamentId: number }
  | { type: "sitOut"; tournamentId: number }
  /** Say something at a table you're seated at or watching. */
  | { type: "chat"; tournamentId: number; tableId: number; text: string };
