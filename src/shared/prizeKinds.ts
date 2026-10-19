// Lucid prize kinds: a Lucid account, Lupees, or anything else. Their names and default DMs,
// shared by the hub server and the dashboard.

import type { PrizeKind, PrizeType } from "./protocol.ts";

export const PRIZE_KINDS: PrizeKind[] = ["account", "lupees", "custom"];

/** Group headings in the dashboard, in the order prizes are listed. */
export const KIND_LABEL: Record<PrizeKind, string> = {
  account: "Lucid accounts",
  lupees: "Lupees",
  custom: "Other",
};

export const MAX_AMOUNT = 100_000_000;

/** 50000 → "50K", 2500 → "2.5K", 1500000 → "1.5M", 750 → "750". */
export function shortAmount(n: number): string {
  if (n >= 1_000_000 && n % 10_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1_000 && n % 100 === 0) return `${n / 1_000}K`;
  return n.toLocaleString("en-US");
}

/** The name a prize gets when you leave it blank: "50K Account", "1,000 Lupees". */
export function prizeName(kind: PrizeKind, amount: number | null): string {
  if (!amount) return "";
  if (kind === "account") return `${shortAmount(amount)} Account`;
  if (kind === "lupees") return `${amount.toLocaleString("en-US")} ${amount === 1 ? "Lupee" : "Lupees"}`;
  return "";
}

/** "Account · $50K", "Lupees · 1,000", "Code pool", "Message". */
export function prizeTypeLabel(p: { kind: PrizeKind; type: PrizeType; amount: number | null }): string {
  if (p.kind === "account") return `Account · $${shortAmount(p.amount ?? 0)}`;
  if (p.kind === "lupees") return `Lupees · ${(p.amount ?? 0).toLocaleString("en-US")}`;
  return p.type === "code_pool" ? "Code pool" : "Message";
}

const DEFAULT_MESSAGES = {
  account: "Congratulations {user}! You placed #{place} in **{event}** and won a **{prize}**.\n\nYour account code: ```{code}```",
  lupees: "Congratulations {user}! You placed #{place} in **{event}** and won **{prize}**.\n\nYour Lupees code: ```{code}```",
  code_pool: "Congratulations {user}! You placed #{place} in **{event}** and won **{prize}**.\n\nYour code: ```{code}```",
  message: "Congratulations {user}! You placed #{place} in **{event}** and won **{prize}**.",
};

export function defaultMessage(kind: PrizeKind, type: PrizeType): string {
  return kind === "custom" ? DEFAULT_MESSAGES[type] : DEFAULT_MESSAGES[kind];
}

/** True for any of the four default DMs, so switching kinds can swap one default for another. */
export const isDefaultMessage = (message: string) => Object.values(DEFAULT_MESSAGES).includes(message);
