// A card is two characters: rank then suit, e.g. "As" (ace of spades), "Td" (ten of diamonds).
export type Card = string;

export const RANKS = "23456789TJQKA";
export const SUITS = "cdhs";

export function fullDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

/** 2..14 (ace high). */
export function rankValue(card: Card): number {
  const i = RANKS.indexOf(card[0]!);
  if (i < 0) throw new Error(`Bad card: ${card}`);
  return i + 2;
}

export function suitOf(card: Card): string {
  return card[1]!;
}

/**
 * Cryptographically secure Fisher–Yates shuffle. Uses Web Crypto, which exists in Node and browsers,
 * with rejection sampling so every permutation is equally likely.
 */
export function shuffledDeck(): Card[] {
  const deck = fullDeck();
  const buf = new Uint32Array(1);
  for (let i = deck.length - 1; i > 0; i--) {
    const range = i + 1;
    const limit = Math.floor(0x100000000 / range) * range;
    let r: number;
    do {
      globalThis.crypto.getRandomValues(buf);
      r = buf[0]!;
    } while (r >= limit);
    const j = r % range;
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}
