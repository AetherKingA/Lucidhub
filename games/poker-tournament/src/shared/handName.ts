// Plain-English names for a hand, for the "your hand" label under your seat.

import { evaluate } from "./engine/evaluator.ts";

const RANK_NAMES: Record<string, [string, string]> = {
  "2": ["Two", "Twos"], "3": ["Three", "Threes"], "4": ["Four", "Fours"], "5": ["Five", "Fives"], "6": ["Six", "Sixes"],
  "7": ["Seven", "Sevens"], "8": ["Eight", "Eights"], "9": ["Nine", "Nines"], T: ["Ten", "Tens"], J: ["Jack", "Jacks"],
  Q: ["Queen", "Queens"], K: ["King", "Kings"], A: ["Ace", "Aces"],
};

/** "Pocket Kings", "Ace-Ten", or after the flop "Two Pair, Aces and Sevens". */
export function describeHand(hole: string[], board: string[]): string | null {
  if (hole.length !== 2 || hole.includes("??")) return null;
  if (board.length < 3) {
    const [a, b] = hole.map((c) => c[0]!).sort((x, y) => "23456789TJQKA".indexOf(y) - "23456789TJQKA".indexOf(x));
    if (a === b) return `Pocket ${RANK_NAMES[a!]![1]}`;
    return `${RANK_NAMES[a!]![0]}-${RANK_NAMES[b!]![0]}${hole[0]![1] === hole[1]![1] ? " suited" : ""}`;
  }
  const v = evaluate([...hole, ...board]);
  const counts = new Map<string, number>();
  for (const c of v.best) counts.set(c[0]!, (counts.get(c[0]!) ?? 0) + 1);
  const withCount = (n: number) => [...counts].filter(([, k]) => k === n).map(([r]) => r).sort((x, y) => "23456789TJQKA".indexOf(y) - "23456789TJQKA".indexOf(x));
  const plural = (r: string) => RANK_NAMES[r]![1];
  switch (v.name) {
    case "Pair":
      return `Pair of ${plural(withCount(2)[0]!)}`;
    case "Two Pair":
      return `Two Pair, ${plural(withCount(2)[0]!)} and ${plural(withCount(2)[1]!)}`;
    case "Three of a Kind":
      return `Three ${plural(withCount(3)[0]!)}`;
    case "Four of a Kind":
      return `Four ${plural(withCount(4)[0]!)}`;
    case "Full House":
      return `Full House, ${plural(withCount(3)[0]!)} full of ${plural(withCount(2)[0]!)}`;
    case "High Card":
      return `${RANK_NAMES[v.best.map((c) => c[0]!).sort((x, y) => "23456789TJQKA".indexOf(y) - "23456789TJQKA".indexOf(x))[0]!]![0]} high`;
    default:
      return v.name;
  }
}
