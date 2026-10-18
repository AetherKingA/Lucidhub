import type { Level, TournamentConfig } from "./types.ts";

const BLINDS: [number, number][] = [
  [25, 50], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [250, 500], [300, 600],
  [400, 800], [500, 1000], [600, 1200], [800, 1600], [1000, 2000], [1200, 2400], [1500, 3000],
  [2000, 4000], [2500, 5000], [3000, 6000], [4000, 8000], [5000, 10000], [6000, 12000],
  [8000, 16000], [10000, 20000], [12500, 25000], [15000, 30000], [20000, 40000], [25000, 50000],
  [30000, 60000], [40000, 80000], [50000, 100000],
];

/** Standard structure: antes (10% of the big blind) start at level 4. */
export function defaultLevels(minutes = 10): Level[] {
  return BLINDS.map(([smallBlind, bigBlind], i) => ({
    smallBlind,
    bigBlind,
    ante: i >= 3 ? Math.round(bigBlind / 10) : 0,
    minutes,
  }));
}

export function defaultConfig(overrides: Partial<TournamentConfig> = {}): TournamentConfig {
  return {
    name: "Tournament",
    startTime: Date.now() + 30 * 60_000,
    startingStack: 10_000,
    tableSize: 9,
    maxPlayers: 1000,
    levels: defaultLevels(),
    lateRegLevels: 6,
    breakEveryLevels: 6,
    breakMinutes: 5,
    decisionSeconds: 20,
    timeBankSeconds: 60,
    timeBankRefillSeconds: 15,
    payoutPercent: 15,
    ...overrides,
  };
}

/**
 * Share of the prize pool for each paid place (index 0 = 1st), in percent. Weighted 1/place so first
 * gets the most and the curve flattens toward the bubble. Sums to 100 (within rounding).
 */
export function payoutPercents(entrants: number, payoutPercent: number): number[] {
  const paid = Math.max(1, Math.min(entrants, Math.floor((entrants * payoutPercent) / 100)));
  const weights = Array.from({ length: paid }, (_, i) => 1 / (i + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => Math.round((w / total) * 10_000) / 100);
}

/** Play-money prize pool: 100 points per entrant, so bigger fields are worth more. */
export function pointsForPlace(place: number, entrants: number, payoutPercent: number): number {
  const pct = payoutPercents(entrants, payoutPercent)[place - 1];
  return pct ? Math.round(pct * entrants) : 0;
}
