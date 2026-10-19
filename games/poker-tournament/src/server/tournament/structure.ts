import type { Level, TournamentConfig } from "./types.ts";

export const TABLE_SIZE = 6;
/** Player caps: powers of 6, so six tables always feed one table in the next round. */
export const PLAYER_CAPS = [6, 36, 216, 1296] as const;

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

/**
 * Ready-made structures for the "create tournament" form. Each sets the blind levels and, where it
 * matters for the pace, the starting stack and breaks.
 */
export interface BlindPreset {
  id: string;
  name: string;
  description: string;
  levels: Level[];
  set: { startingStack?: number; breakEveryLevels?: number; breakMinutes?: number };
}

const withAntes = (levels: [number, number][], minutes: number, anteFrom: number): Level[] =>
  levels.map(([smallBlind, bigBlind], i) => ({ smallBlind, bigBlind, ante: i + 1 >= anteFrom ? Math.round(bigBlind / 10) : 0, minutes }));

export const BLIND_PRESETS: BlindPreset[] = [
  {
    id: "standard",
    name: "Standard",
    description: "10-minute levels, antes from level 4, a 5-minute break every hour. About 2–3 hours for a full table.",
    levels: defaultLevels(10),
    set: { startingStack: 10_000, breakEveryLevels: 6, breakMinutes: 5 },
  },
  {
    id: "turbo",
    name: "Turbo",
    description: "Same blinds, 5-minute levels. About an hour for a full table.",
    levels: defaultLevels(5),
    set: { startingStack: 10_000, breakEveryLevels: 8, breakMinutes: 3 },
  },
  {
    id: "hyper",
    name: "Hyper Turbo",
    description: "3-minute levels that skip a step each time, smaller stacks, antes from level 2, no breaks. 20–30 minutes.",
    levels: withAntes(BLINDS.filter((_, i) => i % 2 === 0), 3, 2),
    set: { startingStack: 5_000, breakEveryLevels: 0, breakMinutes: 0 },
  },
  {
    id: "deep",
    name: "Deep Stack",
    description: "25,000 chips and 15-minute levels for lots of play. Antes from level 6. 4+ hours.",
    levels: withAntes(BLINDS, 15, 6),
    set: { startingStack: 25_000, breakEveryLevels: 4, breakMinutes: 10 },
  },
  {
    id: "casual",
    name: "Casual Evening",
    description: "20-minute levels with a break every hour — relaxed pace for a long night.",
    levels: defaultLevels(20),
    set: { startingStack: 10_000, breakEveryLevels: 3, breakMinutes: 10 },
  },
];

export class StructureError extends Error {}

const MAX_LEVELS = 60;

/**
 * Checks a blind structure someone typed in: whole numbers, big blind at least the small blind,
 * blinds that never go down, sensible level lengths. Throws StructureError naming the bad level.
 */
export function cleanLevels(raw: unknown): Level[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new StructureError("Add at least one blind level");
  if (raw.length > MAX_LEVELS) throw new StructureError(`Keep it to ${MAX_LEVELS} levels or fewer`);
  const out: Level[] = [];
  raw.forEach((l, i) => {
    const n = (v: unknown) => Math.round(Number(v));
    const lv = { smallBlind: n(l?.smallBlind), bigBlind: n(l?.bigBlind), ante: n(l?.ante ?? 0), minutes: n(l?.minutes) };
    const at = `Level ${i + 1}`;
    if (![lv.smallBlind, lv.bigBlind, lv.ante, lv.minutes].every(Number.isFinite)) throw new StructureError(`${at}: fill in every number`);
    if (lv.smallBlind < 1 || lv.bigBlind > 100_000_000) throw new StructureError(`${at}: blinds must be between 1 and 100,000,000`);
    if (lv.bigBlind < lv.smallBlind) throw new StructureError(`${at}: the big blind must be at least the small blind`);
    if (lv.ante < 0 || lv.ante > lv.bigBlind) throw new StructureError(`${at}: the ante must be between 0 and the big blind`);
    if (lv.minutes < 1 || lv.minutes > 120) throw new StructureError(`${at}: levels must last 1–120 minutes`);
    const prev = out[i - 1];
    if (prev && (lv.bigBlind < prev.bigBlind || lv.smallBlind < prev.smallBlind))
      throw new StructureError(`${at}: blinds can't go down from level ${i}`);
    out.push(lv);
  });
  return out;
}

export function defaultConfig(overrides: Partial<TournamentConfig> = {}): TournamentConfig {
  return {
    name: "Tournament",
    startTime: Date.now() + 30 * 60_000,
    startingStack: 10_000,
    tableSize: TABLE_SIZE,
    maxPlayers: 1296,
    levels: defaultLevels(),
    breakEveryLevels: 6,
    breakMinutes: 5,
    decisionSeconds: 20,
    timeBankSeconds: 60,
    timeBankRefillSeconds: 15,
    payoutPercent: 15,
    chipMode: "fair",
    rabbitHunt: true,
    afkKickMinutes: 5,
    ...overrides,
  };
}

/**
 * Number of tables in each round for n players (index 0 = round 1). Round 1 uses as few tables as
 * possible; each later round has one table per six tables of the round before.
 * 216 -> [36, 6, 1], 200 -> [34, 6, 1], 40 -> [7, 2, 1], 6 -> [1].
 */
export function bracketShape(players: number, tableSize = TABLE_SIZE): number[] {
  const counts = [Math.max(1, Math.ceil(players / tableSize))];
  while (counts[counts.length - 1]! > 1) counts.push(Math.ceil(counts[counts.length - 1]! / tableSize));
  return counts;
}

/** Splits `total` items into `parts` groups whose sizes differ by at most one. */
export function evenSplit(total: number, parts: number): number[] {
  return Array.from({ length: parts }, (_, i) => Math.floor(total / parts) + (i < total % parts ? 1 : 0));
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

/**
 * Play-money prize pool: 100 points per entrant, so bigger fields are worth more. Rounded down per
 * place with the leftover points going to the top places, so the total is exactly 100 x entrants.
 */
export function payoutPoints(entrants: number, payoutPercent: number): number[] {
  const pool = entrants * 100;
  const pcts = payoutPercents(entrants, payoutPercent);
  const totalPct = pcts.reduce((a, b) => a + b, 0);
  const points = pcts.map((p) => Math.floor((p / totalPct) * pool));
  let left = pool - points.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0; i = (i + 1) % points.length, left--) points[i]!++;
  return points;
}

export function pointsForPlace(place: number, entrants: number, payoutPercent: number): number {
  return payoutPoints(entrants, payoutPercent)[place - 1] ?? 0;
}
