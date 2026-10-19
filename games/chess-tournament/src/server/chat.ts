// Board chat: the last messages at each board, kept in memory (a restart clears it). Each board has
// two channels: "table", where the players talk and the arbiter posts each game's result, and
// "spectators", where people watching talk among themselves. Players at a board never get its
// spectator chat, so nobody watching can feed them moves.

import { chatRights, messageKind } from "../shared/chatRights.ts";
import type { ChatChannel, ChatMessage } from "../shared/protocol.ts";

export { type ChatPerson, chatRights, defaultChannel, messageKind } from "../shared/chatRights.ts";

export const MAX_CHAT_LENGTH = 200;
const HISTORY = 80;
/** One message per this many ms per person, with a small burst allowance. */
const MIN_GAP_MS = 1200;
const BURST = 3;

/** Trims, collapses whitespace and removes control characters. Empty means "don't send". */
export function cleanChatText(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHAT_LENGTH);
}

export class ChatError extends Error {}

export class TableChats {
  private byTable = new Map<string, ChatMessage[]>();
  private allowance = new Map<number, { tokens: number; at: number }>();
  private nextId = 1;

  history(tableKey: string, channel: ChatChannel): ChatMessage[] {
    return this.byTable.get(`${tableKey}|${channel}`) ?? [];
  }

  drop(tableKey: string) {
    this.byTable.delete(`${tableKey}|table`);
    this.byTable.delete(`${tableKey}|spectators`);
  }

  /** Adds a message from a person, enforcing who may post where and the rate limit. Returns the stored message. */
  say(
    tableKey: string,
    channel: ChatChannel,
    from: { userId: number; username: string; avatarUrl: string; isAdmin: boolean; seated: boolean },
    raw: unknown,
    now: number,
  ) {
    if (!chatRights(from).post.includes(channel))
      throw new ChatError(from.seated ? "Players can't post in the spectator chat" : "Only players and the host talk in the board chat");
    const text = cleanChatText(raw);
    if (!text) throw new ChatError("Type a message first");
    const a = this.allowance.get(from.userId) ?? { tokens: BURST, at: now };
    a.tokens = Math.min(BURST, a.tokens + (now - a.at) / MIN_GAP_MS);
    a.at = now;
    if (a.tokens < 1) throw new ChatError("You're sending messages too fast");
    a.tokens -= 1;
    this.allowance.set(from.userId, a);
    return this.push(tableKey, channel, {
      kind: messageKind(channel, from),
      userId: from.userId,
      username: from.username,
      avatarUrl: from.avatarUrl,
      admin: from.isAdmin,
      text,
      at: now,
    });
  }

  /** A message from the arbiter (game results, draw offers…), always in the players' chat. */
  dealer(tableKey: string, text: string, now: number) {
    return this.push(tableKey, "table", { kind: "dealer", userId: null, username: "Arbiter", avatarUrl: null, admin: false, text, at: now });
  }

  private push(tableKey: string, channel: ChatChannel, m: Omit<ChatMessage, "id">): ChatMessage {
    const k = `${tableKey}|${channel}`;
    const msg: ChatMessage = { id: this.nextId++, ...m };
    const list = this.byTable.get(k) ?? [];
    list.push(msg);
    if (list.length > HISTORY) list.splice(0, list.length - HISTORY);
    this.byTable.set(k, list);
    return msg;
  }
}
