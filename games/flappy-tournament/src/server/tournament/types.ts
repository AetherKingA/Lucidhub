import type { Finale, LobbyAccess, TournamentStatus } from "../../shared/protocol.ts";

export type { LobbyAccess, TournamentStatus };

export interface TournamentConfig {
  name: string;
  startTime: number;
  maxPlayers: number;
  /** How long the clock runs once it starts. */
  durationMinutes: number;
}

export interface PendingEntrant {
  userId: number;
  username: string;
  avatarUrl: string;
  requestedAt: number;
}

export interface BestRun {
  flaps: number[];
  score: number;
  distance: number;
  /** When it was flown (ties go to whoever got there first). */
  setAt: number;
}

export interface Entrant {
  userId: number;
  username: string;
  avatarUrl: string;
  registeredAt: number;
  best: BestRun | null;
  attempts: number;
  place: number | null;
}

/** Everything saved about a tournament. Runs in the air are not saved: a restart pauses the event anyway. */
export interface TournamentMeta {
  id: number;
  config: TournamentConfig;
  status: TournamentStatus;
  /** The course everyone flies. */
  seed: number;
  paused: boolean;
  pauseReason: string | null;
  pausedAt: number | null;
  entrants: Record<number, Entrant>;
  pending?: Record<number, PendingEntrant>;
  kicked?: number[];
  access?: LobbyAccess;
  startedAt: number | null;
  /** When the clock runs out. Moves later by the length of each pause. */
  endsAt: number | null;
  finale: Finale | null;
  finishedAt: number | null;
  savedAt: number;
}
