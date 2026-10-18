import { type Card, rankValue, suitOf } from "./cards.ts";

export const CATEGORY_NAMES = [
  "High Card",
  "Pair",
  "Two Pair",
  "Three of a Kind",
  "Straight",
  "Flush",
  "Full House",
  "Four of a Kind",
  "Straight Flush",
] as const;

export interface HandValue {
  /** Higher is better. Equal scores are a tie. */
  score: number;
  category: number;
  name: string;
  best: Card[];
}

/** Scores exactly five cards. */
export function score5(cards: Card[]): { score: number; category: number } {
  const ranks = cards.map(rankValue).sort((a, b) => b - a);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]!));

  const unique = [...new Set(ranks)];
  let straightHigh = 0;
  if (unique.length === 5) {
    if (unique[0]! - unique[4]! === 4) straightHigh = unique[0]!;
    else if (unique.join() === "14,5,4,3,2") straightHigh = 5; // the wheel: A-2-3-4-5
  }

  // Group by rank: most copies first, then higher rank first.
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map((g) => g[1]).join("");
  const byGroup = groups.map((g) => g[0]);

  let category: number;
  let tiebreak: number[];
  if (straightHigh && flush) [category, tiebreak] = [8, [straightHigh]];
  else if (shape === "41") [category, tiebreak] = [7, byGroup];
  else if (shape === "32") [category, tiebreak] = [6, byGroup];
  else if (flush) [category, tiebreak] = [5, ranks];
  else if (straightHigh) [category, tiebreak] = [4, [straightHigh]];
  else if (shape === "311") [category, tiebreak] = [3, byGroup];
  else if (shape === "221") [category, tiebreak] = [2, byGroup];
  else if (shape === "2111") [category, tiebreak] = [1, byGroup];
  else [category, tiebreak] = [0, ranks];

  let score = category;
  for (let i = 0; i < 5; i++) score = score * 15 + (tiebreak[i] ?? 0);
  return { score, category };
}

/** Best five-card hand from 5 to 7 cards. */
export function evaluate(cards: Card[]): HandValue {
  if (cards.length < 5 || cards.length > 7) throw new Error(`evaluate needs 5-7 cards, got ${cards.length}`);
  let best: HandValue | null = null;
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const five = [cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!];
            const { score, category } = score5(five);
            if (!best || score > best.score) best = { score, category, name: CATEGORY_NAMES[category]!, best: five };
          }
  return best!;
}
