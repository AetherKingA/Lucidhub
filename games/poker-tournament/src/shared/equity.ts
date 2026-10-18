// Your chance of winning the hand, estimated by dealing out the unknown cards many times.
//
// Uses only what you can see (your two cards and the board) and how many opponents are still in.
// Opponents' hands are unknown, so they're dealt at random each time: this is the chance to win
// against random hands, not against what they actually hold.

import { type Card, fullDeck } from "./engine/cards.ts";
import { score5 } from "./engine/evaluator.ts";

export interface Equity {
  /** 0..1: share of deals you win outright. */
  win: number;
  /** 0..1: share of deals you split the pot. */
  tie: number;
  iterations: number;
}

/** Best five-card score from 5–7 cards (higher is better). */
function bestScore(cards: Card[]): number {
  const n = cards.length;
  let best = -1;
  const five: Card[] = new Array(5);
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            five[0] = cards[a]!;
            five[1] = cards[b]!;
            five[2] = cards[c]!;
            five[3] = cards[d]!;
            five[4] = cards[e]!;
            const s = score5(five).score;
            if (s > best) best = s;
          }
  return best;
}

export function estimateEquity(hole: Card[], board: Card[], opponents: number, iterations = 3000, random: () => number = Math.random): Equity | null {
  if (hole.length !== 2 || opponents < 1 || board.length > 5) return null;
  const known = new Set([...hole, ...board]);
  const deck = fullDeck().filter((c) => !known.has(c));
  const need = 5 - board.length + opponents * 2;
  if (need > deck.length) return null;

  let wins = 0;
  let ties = 0;
  const fullBoard: Card[] = [...board];
  for (let it = 0; it < iterations; it++) {
    // Partial Fisher–Yates: only shuffle the cards we need.
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(random() * (deck.length - i));
      const t = deck[i]!;
      deck[i] = deck[j]!;
      deck[j] = t;
    }
    let k = 0;
    fullBoard.length = board.length;
    while (fullBoard.length < 5) fullBoard.push(deck[k++]!);
    const mine = bestScore([...hole, ...fullBoard]);
    let beaten = false;
    let tied = false;
    for (let o = 0; o < opponents && !beaten; o++) {
      const theirs = bestScore([deck[k++]!, deck[k++]!, ...fullBoard]);
      if (theirs > mine) beaten = true;
      else if (theirs === mine) tied = true;
    }
    if (!beaten) {
      if (tied) ties++;
      else wins++;
    }
  }
  return { win: wins / iterations, tie: ties / iterations, iterations };
}
