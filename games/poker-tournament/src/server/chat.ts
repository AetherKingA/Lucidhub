// Table chat: the last messages at each table, kept in memory (a restart clears it). Players at the
// table and people watching it can talk; the dealer posts each hand's result.

import type { ChatMessage } from "../shared/protocol.ts";

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

  history(tableKey: string): ChatMessage[] {
    return this.byTable.get(tableKey) ?? [];
  }

  drop(tableKey: string) {
    this.byTable.delete(tableKey);
  }

  /** Adds a message from a person, enforcing the rate limit. Returns the stored message. */
  say(tableKey: string, from: { userId: number; username: string; avatarUrl: string; isAdmin: boolean; seated: boolean }, raw: unknown, now: number) {
    const text = cleanChatText(raw);
    if (!text) throw new ChatError("Type a message first");
    const a = this.allowance.get(from.userId) ?? { tokens: BURST, at: now };
    a.tokens = Math.min(BURST, a.tokens + (now - a.at) / MIN_GAP_MS);
    a.at = now;
    if (a.tokens < 1) throw new ChatError("You're sending messages too fast");
    a.tokens -= 1;
    this.allowance.set(from.userId, a);
    return this.push(tableKey, {
      kind: from.seated ? "player" : "spectator",
      userId: from.userId,
      username: from.username,
      avatarUrl: from.avatarUrl,
      admin: from.isAdmin,
      text,
      at: now,
    });
  }

  /** A message from the dealer (hand results, players joining…). */
  dealer(tableKey: string, text: string, now: number) {
    return this.push(tableKey, { kind: "dealer", userId: null, username: "Dealer", avatarUrl: null, admin: false, text, at: now });
  }

  private push(tableKey: string, m: Omit<ChatMessage, "id">): ChatMessage {
    const msg: ChatMessage = { id: this.nextId++, ...m };
    const list = this.byTable.get(tableKey) ?? [];
    list.push(msg);
    if (list.length > HISTORY) list.splice(0, list.length - HISTORY);
    this.byTable.set(tableKey, list);
    return msg;
  }
}
