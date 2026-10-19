import type { TournamentConfig } from "./types.ts";

export const WINS_TO_ADVANCE = [1, 2, 3] as const;
/** Time controls offered when creating a tournament: [minutes, increment seconds]. */
export const TIME_CONTROLS = [
  [1, 0],
  [3, 0],
  [3, 2],
  [5, 0],
  [5, 3],
  [10, 0],
  [10, 5],
  [15, 10],
] as const;
export const MAX_PLAYERS = 1024;
/** Each player gets this long to make their first move of a game, or they lose it. */
export const FIRST_MOVE_MS = 30_000;
/** Draws in a row before the next game is Armageddon (a draw counts as a win for Black). */
export const DRAWS_BEFORE_ARMAGEDDON = 2;

export function defaultConfig(): TournamentConfig {
  return {
    name: "Chess Night",
    startTime: Date.now() + 30 * 60_000,
    maxPlayers: 64,
    winsToAdvance: 1,
    minutes: 5,
    incrementSeconds: 3,
  };
}

export const timeControlLabel = (minutes: number, increment: number) => `${minutes}+${increment}`;

/**
 * Matches per round, first round first: a knockout bracket sized to the next power of two, so
 * players without an opponent in round 1 get a bye and every later round pairs up evenly.
 */
export function bracketShape(players: number): number[] {
  let slots = 2;
  while (slots < players) slots *= 2;
  const counts: number[] = [];
  for (let n = slots / 2; n >= 1; n /= 2) counts.push(n);
  return counts;
}

/** Order to hand out second players in round 1 so the byes end up spread across the bracket. */
export function spreadOrder(n: number): number[] {
  const bits = Math.round(Math.log2(n));
  return Array.from({ length: n }, (_, i) => {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    return r;
  });
}
