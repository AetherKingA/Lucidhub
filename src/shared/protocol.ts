// Types shared by the hub server and the dashboard. The first block is the game connector contract
// (INTEGRATION.md): what every game site returns to the hub.

// ---------------------------------------------------------------- game connector contract

/** One input on a game's "create event" form. The dashboard renders the form from these. */
export interface GameField {
  name: string;
  label: string;
  /** "blinds": a blind structure editor whose value is a list of levels. */
  type: "text" | "number" | "datetime" | "select" | "blinds";
  default?: string | number | BlindLevel[];
  min?: number;
  max?: number;
  options?: { value: string | number; label: string }[];
  /** For "blinds": ready-made structures from the game. */
  presets?: BlindPreset[];
  help?: string;
}

export interface BlindLevel {
  smallBlind: number;
  bigBlind: number;
  ante: number;
  minutes: number;
}

/** A named blind structure. `set` fills other fields of the form too (starting stack, breaks…). */
export interface BlindPreset {
  id: string;
  name: string;
  description?: string;
  levels: BlindLevel[];
  set?: Record<string, number>;
  /** Saved by you in the hub (can be deleted), rather than built into the game. */
  saved?: boolean;
}

/** GET /api/integration/info */
export interface GameInfo {
  key: string;
  name: string;
  fields: GameField[];
}

export type GameEventStatus = "registering" | "running" | "finished" | "cancelled";

/** An event as a game site reports it. */
export interface GameEvent {
  id: string;
  name: string;
  status: GameEventStatus;
  startTime: number | null;
  entrants: number;
  maxPlayers: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  url: string | null;
  /** Optional: games that support closed lobbies report these. */
  access?: LobbyAccess;
  /** Join requests waiting for an admin (closed lobbies). */
  pending?: number;
}

/** "open": anyone can join. "closed": players ask, and an admin approves each one. */
export type LobbyAccess = "open" | "closed";

export type PlayerStatus = "pending" | "registered" | "playing" | "waiting" | "out" | "removed";

export interface GamePlayer {
  discordId: string;
  username: string;
  avatarUrl: string;
  status: PlayerStatus;
  place: number | null;
}

/** GET /api/integration/events/:id/players, and the answer to every lobby change. */
export interface GameLobby {
  access: LobbyAccess;
  players: GamePlayer[];
}

export type PlayerAction = "approve" | "deny" | "kick";

/** GET /api/integration/events/:id/results */
export interface GameResults {
  id: string;
  status: GameEventStatus;
  finishedAt: number | null;
  results: { discordId: string; username: string; place: number }[];
}

export type GameOp = "start" | "pause" | "resume" | "cancel";

// ---------------------------------------------------------------- hub API

export interface AdminInfo {
  discordId: string;
  username: string;
  avatarUrl: string;
}

export interface GameRow {
  id: number;
  key: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  lastOkAt: number | null;
  lastError: string | null;
  /** The webhook URL to put in the game's config. */
  webhookUrl: string;
  launchDir: string | null;
  launchCmd: string | null;
  autostart: boolean;
  publicAccess: boolean;
  funnelPort: number;
}

export type ServerState = "stopped" | "starting" | "running" | "stopping" | "crashed";

/** A game server the hub runs as a background process. */
export interface ServerStatus {
  gameId: number;
  state: ServerState;
  pid: number | null;
  startedAt: number | null;
  /** The game answered the hub since it was started. */
  ready: boolean;
  exitCode: number | null;
  /** Crash restarts in the last 10 minutes. */
  recentRestarts: number;
  message: string | null;
  /** Where players reach the game (the Funnel address when it is public, else this PC only). */
  publicUrl: string | null;
  /** Set when Tailscale needs a one-time approval in the browser before the game can go public. */
  approveUrl: string | null;
}

export interface PrizeRule {
  id?: number;
  placeFrom: number;
  placeTo: number;
  prizeId: number;
}

export interface HubEvent {
  id: number;
  gameId: number;
  gameName: string;
  externalId: string;
  name: string;
  status: GameEventStatus;
  startTime: number | null;
  entrants: number;
  maxPlayers: number | null;
  url: string | null;
  /** Null when the game doesn't support closed lobbies. */
  access: LobbyAccess | null;
  pending: number;
  announceChannelId: string | null;
  processedAt: number | null;
  rules: PrizeRule[];
  awardCounts: Record<string, number>;
}

export type PrizeType = "code_pool" | "message";

export interface Prize {
  id: number;
  name: string;
  type: PrizeType;
  message: string;
  imageUrl: string | null;
  lowStockThreshold: number;
  archived: boolean;
  /** Unused codes (code pools only). */
  stock: number;
  usedCodes: number;
}

export type AwardStatus = "pending" | "waiting_stock" | "sent" | "dm_failed" | "cancelled" | "manual";

export interface Award {
  id: number;
  eventId: number;
  eventName: string;
  prizeId: number;
  prizeName: string;
  discordId: string;
  username: string;
  place: number;
  status: AwardStatus;
  attempts: number;
  lastError: string | null;
  sentAt: number | null;
  createdAt: number;
  hasCode: boolean;
}

export interface Template {
  id: number;
  name: string;
  rules: PrizeRule[];
}

export interface HubSettings {
  guildId: string;
  announceChannelId: string;
  alertsChannelId: string;
}

export interface BotStatus {
  configured: boolean;
  online: boolean;
  tag: string | null;
  inviteUrl: string | null;
  guilds: { id: string; name: string }[];
  channels: { id: string; name: string }[];
}

export interface Overview {
  upcoming: HubEvent[];
  live: HubEvent[];
  recentAwards: Award[];
  attention: { kind: "dm_failed" | "waiting_stock" | "low_stock" | "game_offline" | "bot_offline"; message: string }[];
}
