// Uno cards as short strings, so game state is small plain JSON:
//   colored: color letter + value — "r7", "gS" (skip), "bR" (reverse), "yD" (draw two)
//   wild: "W"     wild draw four: "W4"
// Identical cards are interchangeable, so a play names the card, not a position in the hand.

export const COLORS = ["r", "y", "g", "b"] as const;
export type Color = (typeof COLORS)[number];
export type Card = string;

export const COLOR_NAMES: Record<Color, string> = { r: "red", y: "yellow", g: "green", b: "blue" };

export const isWild = (c: Card) => c === "W" || c === "W4";
export const colorOf = (c: Card): Color | null => (isWild(c) ? null : (c[0] as Color));
/** "7", "S", "R", "D", "W" or "W4". */
export const valueOf = (c: Card) => (isWild(c) ? c : c.slice(1));
export const isDraw = (c: Card) => c === "W4" || valueOf(c) === "D";

export function isCard(c: unknown): c is Card {
  return typeof c === "string" && (c === "W" || c === "W4" || /^[rygb]([0-9]|S|R|D)$/.test(c));
}

/** The 108-card deck: per color one 0, two each of 1–9, Skip, Reverse and Draw Two; four Wild and four Wild Draw Four. */
export function fullDeck(): Card[] {
  const deck: Card[] = [];
  for (const c of COLORS) {
    deck.push(`${c}0`);
    for (const v of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "S", "R", "D"]) deck.push(`${c}${v}`, `${c}${v}`);
  }
  for (let i = 0; i < 4; i++) deck.push("W", "W4");
  return deck;
}

/** Points a card left in a hand is worth: number cards their face value, actions 20, wilds 50. */
export function cardPoints(c: Card): number {
  if (isWild(c)) return 50;
  const v = valueOf(c);
  return /^\d$/.test(v) ? Number(v) : 20;
}

export const handPoints = (cards: Card[]) => cards.reduce((n, c) => n + cardPoints(c), 0);

const VALUE_NAMES: Record<string, string> = { S: "Skip", R: "Reverse", D: "Draw Two", W: "Wild", W4: "Wild Draw Four" };

/** "Red 7", "Blue Skip", "Wild Draw Four". */
export function cardName(c: Card): string {
  const v = valueOf(c);
  if (isWild(c)) return VALUE_NAMES[v]!;
  const color = COLOR_NAMES[colorOf(c)!];
  return `${color[0]!.toUpperCase()}${color.slice(1)} ${VALUE_NAMES[v] ?? v}`;
}

/** Seeded random numbers (mulberry32). The state lives in the game so a saved game replays the same way. */
export function nextRandom(s: { rng: number }): number {
  let t = (s.rng = (s.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function shuffle<T>(arr: T[], s: { rng: number }): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(s) * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}
