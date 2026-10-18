// Types shared by the hub server and the dashboard. The first block is the game connector contract
// (INTEGRATION.md): what every game site returns to the hub.

// ---------------------------------------------------------------- game connector contract

/** One input on a game's "create event" form. The dashboard renders the form from these. */
export interface GameField {
  name: string;
  label: string;
  type: "text" | "number" | "datetime" | "select";
  default?: string | number;
  min?: number;
  max?: number;
  options?: { value: string | number; label: string }[];
  help?: string;
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
}

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
