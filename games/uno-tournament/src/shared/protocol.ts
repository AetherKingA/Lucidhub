// Messages exchanged over the WebSocket, and the views the server sends. Shared by server and client
// so both stay in sync.

import type { Card, Color } from "./engine/cards.ts";
import type { Action, LegalActions } from "./engine/game.ts";

export type { Action, Card, Color, LegalActions };

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
  tableSize: number;
  winsToAdvance: number;
  stacking: boolean;
  /** Earliest round still being played (1-based). Before the start: 1. */
  round: number;
  /** Rounds in the bracket (projected from current registrations before the start). */
  totalRounds: number;
  activeTables: number;
  registrationOpen: boolean;
  me: {
    registered: boolean;
    tableId: number | null;
    place: number | null;
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
  cardCount: number;
  /** Hands won at this table. */
  wins: number;
  /** Card points left over from lost hands at this table (tiebreak; lower is better). */
  points: number;
  away: boolean;
  connected: boolean;
  calledUno: boolean;
  /** Down to one card without calling UNO: anyone can catch them right now. */
  catchable: boolean;
  /** After a hand: the card points they were left holding (null for the winner and during play). */
  handPoints: number | null;
  timeBankMs: number;
}

export interface TableView {
  tournamentId: number;
  tableId: number;
  tableSize: number;
  seats: (SeatView | null)[];
  dealer: number;
  handNo: number;
  topCard: Card | null;
  /** The color to match (a wild's chosen color). */
  color: Color | null;
  direction: 1 | -1;
  drawPileCount: number;
  /** Stacking: cards the player to act draws unless they stack. */
  pendingDraw: number;
  toActSeat: number | null;
  actionStartedAt: number | null;
  decisionMs: number;
  /** When the acting player times out (including their time bank). */
  actionDeadline: number | null;
  round: number;
  totalRounds: number;
  winsToAdvance: number;
  stacking: boolean;
  /** The viewer's own cards (empty for spectators). Nobody else's cards are ever sent. */
  myHand: Card[];
  /** Present only for the viewer whose turn it is. */
  legal: LegalActions | null;
  /** The viewer may press UNO now (one or two cards, not called yet). */
  canCallUno: boolean;
  mySeat: number | null;
  /** Recent plays, newest last: "Alex played Red 7". */
  events: string[];
  /** Seat that won the hand just finished, while its result is on screen. */
  handWinnerSeat: number | null;
  handComplete: boolean;
  paused: boolean;
  serverNow: number;
}

export interface TournamentDetail {
  summary: TournamentSummary;
  rounds: { round: number; tables: number; done: number; players: number }[];
  tables: { id: number; round: number; players: number; handNo: number; leader: string | null; leaderWins: number }[];
  /** Players still in (furthest round first, then hand wins), then knocked-out players by place. */
  standings: { userId: number; username: string; round: number; wins: number; place: number | null; tableId: number | null }[];
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
  | { type: "finished"; tournamentId: number; place: number }
  | { type: "advanced"; tournamentId: number; round: number; totalRounds: number }
  /** replace: the table's whole recent history (sent when you start watching); otherwise new messages. */
  | { type: "chat"; tournamentId: number; tableId: number; messages: ChatMessage[]; replace: boolean };

export type ClientMessage =
  | { type: "ping"; t: number }
  | { type: "register"; tournamentId: number }
  | { type: "unregister"; tournamentId: number }
  /** Start receiving updates for a table (null to stop). Players are always sent their own table. */
  | { type: "watch"; tournamentId: number; tableId: number | null }
  /** play / draw / pass on your turn; uno and catch any time. catch names the seat to catch. */
  | { type: "action"; tournamentId: number; action: ClientAction }
  /** Stop being played for automatically after timing out. */
  | { type: "back"; tournamentId: number }
  /** Say something at a table you're seated at or watching. */
  | { type: "chat"; tournamentId: number; tableId: number; text: string };

export type ClientAction =
  | { type: "play"; card: Card; color?: Color; uno?: boolean }
  | { type: "draw" }
  | { type: "pass" }
  | { type: "uno" }
  | { type: "catch"; seat: number };
