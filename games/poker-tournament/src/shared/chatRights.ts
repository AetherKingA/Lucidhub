// Who can read and post in each chat at a table. Shared so the page shows the same rule the server enforces.
// The same in all three games (poker, Uno, chess).

import type { ChatChannel, ChatMessage } from "./protocol.ts";

export interface ChatPerson {
  /** Sitting at this table. */
  seated: boolean;
  isAdmin: boolean;
}

/**
 * Seated players: only the table chat (they never see the spectator chat, so nobody can tip them off).
 * Spectators: read both, post with other spectators. An admin who isn't seated also talks to the table (as Host).
 */
export function chatRights(p: ChatPerson): { read: ChatChannel[]; post: ChatChannel[] } {
  if (p.seated) return { read: ["table"], post: ["table"] };
  if (p.isAdmin) return { read: ["table", "spectators"], post: ["table", "spectators"] };
  return { read: ["table", "spectators"], post: ["spectators"] };
}

/** Where a message goes when the client doesn't say (older pages): players to the table, everyone else to spectators. */
export function defaultChannel(p: ChatPerson): ChatChannel {
  return p.seated ? "table" : "spectators";
}

export function messageKind(channel: ChatChannel, p: ChatPerson): ChatMessage["kind"] {
  if (channel === "spectators") return "spectator";
  return p.seated ? "player" : "host";
}
