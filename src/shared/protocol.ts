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
  phase: "level" | "break";
  /** 0-based level index. */
  level: number;
  levelInfo: LevelInfo;
  nextLevelInfo: LevelInfo | null;
  /** Epoch ms when the current level/break ends, or null (paused or final level). */
  phaseEndsAt: number | null;
  /** Time left in the phase when paused. */
  phaseRemainingMs: number | null;
  lateRegOpen: boolean;
  me: { registered: boolean; tableId: number | null; place: number | null; points: number } | null;
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
  level: LevelInfo;
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
  lateRegLevels: number;
  payouts: { place: number; percent: number; points: number }[];
  tables: { id: number; players: number; handNo: number }[];
  /** Chip leaders while running; final results when finished. */
  standings: { userId: number; username: string; chips: number; place: number | null; points: number; tableId: number | null }[];
  averageStack: number;
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
  | { type: "finished"; tournamentId: number; place: number; points: number };

export type ClientMessage =
  | { type: "ping"; t: number }
  | { type: "register"; tournamentId: number }
  | { type: "unregister"; tournamentId: number }
  /** Start receiving updates for a table (null to stop). Players are always sent their own table. */
  | { type: "watch"; tournamentId: number; tableId: number | null }
  | { type: "action"; tournamentId: number; action: Action }
  | { type: "back"; tournamentId: number }
  | { type: "sitOut"; tournamentId: number };
