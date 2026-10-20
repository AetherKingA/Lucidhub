// Messages between the browser and the game server (over the /ws WebSocket), plus the views they carry.

export type TournamentStatus = "registering" | "running" | "finale" | "finished" | "cancelled";
export type LobbyAccess = "open" | "closed";

export interface UserInfo {
  id: number;
  username: string;
  avatarUrl: string;
  isAdmin: boolean;
}

export interface MyEntry {
  registered: boolean;
  /** Asked to join a closed lobby. */
  pending: boolean;
  /** Kicked by an admin. */
  removed: boolean;
  best: { score: number; distance: number } | null;
  attempts: number;
  place: number | null;
}

export interface TournamentSummary {
  id: number;
  name: string;
  status: TournamentStatus;
  paused: boolean;
  pauseReason: string | null;
  startTime: number;
  durationMinutes: number;
  /** When the clock runs out (moves on resume). Null before the start. */
  endsAt: number | null;
  /** Time left while paused. */
  remainingMs: number | null;
  entrants: number;
  maxPlayers: number;
  access: LobbyAccess;
  /** Can sign up right now (before the start, or late while the clock runs). */
  registrationOpen: boolean;
  me: MyEntry | null;
}

export interface Ghost {
  userId: number;
  username: string;
  avatarUrl: string;
  flaps: number[];
  score: number;
  distance: number;
  place: number;
}

export interface Finale {
  /** Server time the replay begins (after a short countdown). */
  startsAt: number;
  /** How many times faster than real time the ghosts fly. */
  speed: number;
  /** Server time the event finishes, once the replay and the winner's moment are over. */
  endsAt: number;
  ghosts: Ghost[];
}

export interface ResultRow {
  userId: number;
  username: string;
  avatarUrl: string;
  place: number;
  score: number | null;
  distance: number | null;
}

export interface TournamentView extends TournamentSummary {
  /** The course. Only once it has started, so nobody can practise it early. */
  seed: number | null;
  players: { userId: number; username: string; avatarUrl: string }[];
  finale: Finale | null;
  results: ResultRow[] | null;
}

export type ClientMessage =
  | { type: "ping"; t: number }
  | { type: "open"; tournamentId: number | null }
  | { type: "register"; tournamentId: number }
  | { type: "unregister"; tournamentId: number }
  | { type: "runStart"; tournamentId: number }
  | { type: "runEnd"; tournamentId: number; flaps: number[] };

export type ServerMessage =
  | { type: "hello"; user: UserInfo; serverNow: number }
  | { type: "pong"; t: number; serverNow: number }
  | { type: "lobby"; tournaments: TournamentSummary[]; serverNow: number }
  | { type: "tournament"; view: TournamentView; serverNow: number }
  | { type: "runStarted"; tournamentId: number }
  | { type: "runSaved"; tournamentId: number; score: number; distance: number; newBest: boolean }
  | { type: "error"; message: string };
