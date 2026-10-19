import type { TournamentConfig } from "./types.ts";

export const TABLE_SIZES = [3, 4, 5, 6] as const;
export const WINS_TO_ADVANCE = [1, 2, 3] as const;
export const MAX_PLAYERS = 1000;

export function defaultConfig(): TournamentConfig {
  return {
    name: "Uno Night",
    startTime: Date.now() + 30 * 60_000,
    maxPlayers: 100,
    tableSize: 4,
    winsToAdvance: 2,
    stacking: false,
    decisionSeconds: 20,
    timeBankSeconds: 60,
  };
}

/**
 * Tables per round, first round first: enough round-1 tables for everyone, then each round has one
 * table per `tableSize` tables of the round before, down to one final table.
 */
export function bracketShape(players: number, tableSize: number): number[] {
  const counts = [Math.max(1, Math.ceil(players / tableSize))];
  while (counts[counts.length - 1]! > 1) counts.push(Math.ceil(counts[counts.length - 1]! / tableSize));
  return counts;
}

/** Splits `total` items into `parts` groups whose sizes differ by at most one. */
export function evenSplit(total: number, parts: number): number[] {
  return Array.from({ length: parts }, (_, i) => Math.floor(total / parts) + (i < total % parts ? 1 : 0));
}
