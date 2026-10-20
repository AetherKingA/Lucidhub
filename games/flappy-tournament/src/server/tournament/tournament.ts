import { MAX_RUN_TICKS, TICK_MS, TICKS_PER_SECOND, compareRuns, simulate, validFlaps } from "../../shared/engine/flappy.ts";
import type { Finale, Ghost, MyEntry, ResultRow, TournamentSummary, TournamentView } from "../../shared/protocol.ts";
import type { Entrant, LobbyAccess, TournamentConfig, TournamentMeta } from "./types.ts";

export class TournamentError extends Error {}

/** What a tournament tells the outside world. The manager wires these up; tests use noopHooks. */
export interface TournamentHooks {
  /** The lobby or a player list changed (also keeps the hub's dashboard live). */
  lobbyChanged(): void;
  /** Something every viewer of this tournament sees changed. */
  changed(): void;
  /** The finale is over and the results are final. */
  tournamentFinished(results: { userId: number; place: number }[]): void;
  dirty(): void;
}

export const noopHooks: TournamentHooks = {
  lobbyChanged: () => {},
  changed: () => {},
  tournamentFinished: () => {},
  dirty: () => {},
};

export interface NewEntrant {
  id: number;
  username: string;
  avatarUrl: string;
}

/**
 * Leeway for a run's length, in ticks. The browser starts flying the moment the player taps, a
 * little before the server hears about it, so a run can be slightly longer than the server's clock says.
 */
export const GRACE_TICKS = 2 * TICKS_PER_SECOND;
/** After the clock runs out, runs still being sent in have this long to arrive before the finale. */
export const COLLECT_MS = 3000;
/** Countdown before the ghosts take off. */
export const FINALE_COUNTDOWN_MS = 4000;
/** The ghost replay lasts at most about this long... */
export const FINALE_MAX_REPLAY_MS = 45_000;
/** ...and is always at least this much faster than real time. */
export const FINALE_MIN_SPEED = 2;
/** Time on the winner and the podium before the event finishes. */
export const FINALE_HOLD_MS = 6000;

export class Tournament {
  meta: TournamentMeta;
  hooks: TournamentHooks;
  /** Runs in the air: when the server heard each one start. Not saved. */
  private active = new Map<number, number>();

  constructor(meta: TournamentMeta, hooks: TournamentHooks = noopHooks) {
    this.meta = meta;
    this.hooks = hooks;
  }

  static create(id: number, config: TournamentConfig, seed: number, now: number, hooks?: TournamentHooks) {
    const meta: TournamentMeta = {
      id,
      config,
      status: "registering",
      seed,
      paused: false,
      pauseReason: null,
      pausedAt: null,
      entrants: {},
      startedAt: null,
      endsAt: null,
      finale: null,
      finishedAt: null,
      savedAt: now,
    };
    return new Tournament(meta, hooks);
  }

  get id() {
    return this.meta.id;
  }
  get config() {
    return this.meta.config;
  }
  get entrantCount() {
    return Object.keys(this.meta.entrants).length;
  }
  get access(): LobbyAccess {
    return this.meta.access ?? "open";
  }

  private touch(lobby = true) {
    this.hooks.dirty();
    this.hooks.changed();
    if (lobby) this.hooks.lobbyChanged();
  }

  /** Before the start, or late while the clock is still running. */
  private canJoin(now: number) {
    const m = this.meta;
    return m.status === "registering" || (m.status === "running" && m.endsAt !== null && now < m.endsAt);
  }

  // ---------------------------------------------------------------- registration

  register(user: NewEntrant, now: number) {
    const m = this.meta;
    if (!this.canJoin(now)) throw new TournamentError("Registration is closed");
    if (m.entrants[user.id]) throw new TournamentError("You are already registered");
    if (m.kicked?.includes(user.id)) throw new TournamentError("An admin removed you from this tournament");
    if (this.access === "closed") {
      if (m.pending?.[user.id]) throw new TournamentError("You already asked to join. An admin will let you in.");
      if (this.entrantCount >= m.config.maxPlayers) throw new TournamentError("The tournament is full");
      (m.pending ??= {})[user.id] = { userId: user.id, username: user.username, avatarUrl: user.avatarUrl, requestedAt: now };
      this.touch();
      return;
    }
    this.admit(user, now);
  }

  private admit(user: NewEntrant, now: number) {
    const m = this.meta;
    if (this.entrantCount >= m.config.maxPlayers) throw new TournamentError("The tournament is full");
    m.entrants[user.id] = {
      userId: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      registeredAt: now,
      best: null,
      attempts: 0,
      place: null,
    };
    this.touch();
  }

  unregister(userId: number) {
    const m = this.meta;
    if (m.pending?.[userId]) {
      delete m.pending[userId];
      this.touch();
      return;
    }
    if (m.status !== "registering") throw new TournamentError("You can't unregister once the tournament has started");
    if (!m.entrants[userId]) throw new TournamentError("You are not registered");
    delete m.entrants[userId];
    this.touch();
  }

  /** Opening the lobby lets in everyone who was waiting, while there's room. */
  setAccess(access: LobbyAccess, now: number) {
    const m = this.meta;
    if (this.isOver()) throw new TournamentError("The tournament is already over");
    m.access = access;
    if (access === "open" && this.canJoin(now)) {
      for (const p of Object.values(m.pending ?? {}).sort((a, b) => a.requestedAt - b.requestedAt)) {
        if (this.entrantCount >= m.config.maxPlayers) break;
        this.admit({ id: p.userId, username: p.username, avatarUrl: p.avatarUrl }, now);
        delete m.pending![p.userId];
      }
    }
    this.touch();
  }

  approve(userId: number, now: number) {
    const m = this.meta;
    const p = m.pending?.[userId];
    if (!p) throw new TournamentError("That player hasn't asked to join");
    if (!this.canJoin(now)) throw new TournamentError("Registration is closed");
    this.admit({ id: p.userId, username: p.username, avatarUrl: p.avatarUrl }, now);
    delete m.pending![userId];
    this.touch();
  }

  deny(userId: number) {
    if (!this.meta.pending?.[userId]) throw new TournamentError("That player hasn't asked to join");
    delete this.meta.pending[userId];
    this.touch();
  }

  /** Removes a player for good: they leave the field before the start, and lose their runs after it. */
  kick(userId: number, _now: number) {
    const m = this.meta;
    if (this.isOver()) throw new TournamentError("The tournament is already over");
    if (m.status === "finale") throw new TournamentError("The finale has already started");
    const e = m.entrants[userId];
    const asked = Boolean(m.pending?.[userId]);
    if (!e && !asked) throw new TournamentError("That player isn't in this tournament");
    if (m.kicked?.includes(userId)) throw new TournamentError("That player was already kicked");
    (m.kicked ??= []).push(userId);
    if (asked) delete m.pending![userId];
    if (e && m.status === "registering") delete m.entrants[userId];
    else if (e) e.best = null;
    this.active.delete(userId);
    this.touch();
  }

  isKicked(userId: number) {
    return Boolean(this.meta.kicked?.includes(userId));
  }

  isOver() {
    return this.meta.status === "finished" || this.meta.status === "cancelled";
  }

  // ---------------------------------------------------------------- lifecycle

  start(now: number) {
    const m = this.meta;
    if (m.status !== "registering") throw new TournamentError("The tournament has already started");
    if (this.entrantCount < 2) throw new TournamentError("At least two players must be registered to start");
    m.status = "running";
    m.startedAt = now;
    m.endsAt = now + m.config.durationMinutes * 60_000;
    m.paused = false;
    m.pauseReason = null;
    m.pausedAt = null;
    this.touch();
  }

  /** Freezes the clock. Runs in the air end where they are and still count. */
  pause(reason: string, now: number) {
    const m = this.meta;
    if (m.status !== "running") throw new TournamentError("The tournament is not running");
    if (m.paused) throw new TournamentError("Already paused");
    if (m.endsAt !== null && now >= m.endsAt) throw new TournamentError("Time is already up");
    m.paused = true;
    m.pauseReason = reason;
    m.pausedAt = now;
    this.touch();
  }

  /** The clock carries on with the time that was left. */
  resume(now: number) {
    const m = this.meta;
    if (!m.paused || m.pausedAt === null) throw new TournamentError("The tournament is not paused");
    if (m.endsAt !== null) m.endsAt += now - m.pausedAt;
    m.paused = false;
    m.pauseReason = null;
    m.pausedAt = null;
    // Runs from before the pause were sent in when it began; anything left over doesn't count.
    this.active.clear();
    this.touch();
  }

  /**
   * After loading from disk: a running clock comes back paused at the moment it was last saved,
   * and a finale that was cut off goes straight to the results.
   */
  restoreAfterRestart(now: number) {
    const m = this.meta;
    if (m.status === "running" && !m.paused) {
      m.paused = true;
      m.pausedAt = Math.min(m.savedAt, m.endsAt ?? m.savedAt);
      m.pauseReason = "The server restarted. An admin needs to resume the tournament.";
      this.hooks.dirty();
    }
    if (m.status === "finale") this.finish(now);
  }

  cancel(now: number) {
    const m = this.meta;
    if (this.isOver()) throw new TournamentError("The tournament is already over");
    m.status = "cancelled";
    m.finishedAt = now;
    m.paused = false;
    this.active.clear();
    this.touch();
  }

  tick(now: number) {
    const m = this.meta;
    if (m.status === "registering" && !m.paused && now >= m.config.startTime && this.entrantCount >= 2) this.start(now);
    if (m.status === "running" && !m.paused && m.endsAt !== null) {
      // Time's up: wait a moment for the last runs to arrive, then roll the ghosts.
      if (now >= m.endsAt + COLLECT_MS || (now >= m.endsAt && this.active.size === 0)) this.beginFinale(now);
      // Keep savedAt fresh so a crash resumes from close to the right moment.
      else if (now - m.savedAt > 5000) this.hooks.dirty();
    }
    if (m.status === "finale" && m.finale && now >= m.finale.endsAt) this.finish(now);
  }

  // ---------------------------------------------------------------- runs

  /** A player took off. The server's clock for the run starts now. */
  startRun(userId: number, now: number) {
    const m = this.meta;
    if (m.status !== "running" || m.endsAt === null) throw new TournamentError("The tournament isn't running");
    if (m.paused) throw new TournamentError("The tournament is paused");
    if (now >= m.endsAt) throw new TournamentError("Time is up");
    if (!m.entrants[userId] || this.isKicked(userId)) throw new TournamentError("You aren't playing in this tournament");
    this.active.set(userId, now);
  }

  /**
   * A run ended (crash, or the clock ran out). The server replays the flaps on the course itself, and
   * only counts what fits in the time that really passed, so a made-up run can't score.
   */
  endRun(userId: number, flaps: unknown, now: number): { score: number; distance: number; newBest: boolean } {
    const m = this.meta;
    const startedAt = this.active.get(userId);
    if (startedAt === undefined) throw new TournamentError("That run didn't count (it started before a pause, or after time ran out)");
    this.active.delete(userId);
    const e = m.entrants[userId];
    if (!e || this.isKicked(userId)) throw new TournamentError("You aren't playing in this tournament");
    if (m.status !== "running" || m.endsAt === null) throw new TournamentError("The tournament isn't running");
    if (!validFlaps(flaps)) throw new TournamentError("Invalid run");

    const stop = Math.min(now, m.endsAt, m.pausedAt ?? Infinity);
    const allowed = Math.min(MAX_RUN_TICKS, Math.max(0, Math.floor((stop - startedAt) / TICK_MS)) + GRACE_TICKS);
    // Never past the deadline itself, whatever the grace.
    const deadlineTicks = Math.max(0, Math.ceil((m.endsAt - startedAt) / TICK_MS)) + GRACE_TICKS;
    const maxTicks = Math.min(allowed, deadlineTicks);
    const result = simulate(m.seed, flaps, maxTicks);
    const kept = flaps.filter((f) => f < result.distance);

    e.attempts++;
    const run = { flaps: kept, score: result.score, distance: result.distance, setAt: now };
    const newBest = !e.best || compareRuns(run, e.best) < 0;
    if (newBest) e.best = run;
    this.hooks.dirty();
    this.hooks.changed();
    return { score: result.score, distance: result.distance, newBest };
  }

  hasActiveRun(userId: number) {
    return this.active.has(userId);
  }

  // ---------------------------------------------------------------- finale and results

  /** Final places: best runs first, then everyone without a run sharing the next place, then kicked players. */
  standings(): { entrant: Entrant; place: number }[] {
    const all = Object.values(this.meta.entrants);
    const flew = all.filter((e) => e.best && !this.isKicked(e.userId)).sort((a, b) => compareRuns(a.best!, b.best!));
    const rest = all.filter((e) => !e.best && !this.isKicked(e.userId)).sort((a, b) => a.registeredAt - b.registeredAt);
    const kicked = all.filter((e) => this.isKicked(e.userId));
    const rows = flew.map((entrant, i) => ({ entrant, place: i + 1 }));
    for (const entrant of rest) rows.push({ entrant, place: flew.length + 1 });
    const kickedPlace = flew.length + (rest.length ? 1 : 0) + 1;
    for (const entrant of kicked) rows.push({ entrant, place: kickedPlace });
    return rows;
  }

  private beginFinale(now: number) {
    const m = this.meta;
    this.active.clear();
    const rows = this.standings();
    for (const { entrant, place } of rows) entrant.place = place;
    const ghosts: Ghost[] = rows
      .filter(({ entrant }) => entrant.best && !this.isKicked(entrant.userId))
      .map(({ entrant: e, place }) => ({
        userId: e.userId,
        username: e.username,
        avatarUrl: e.avatarUrl,
        flaps: e.best!.flaps,
        score: e.best!.score,
        distance: e.best!.distance,
        place,
      }));
    const longestMs = Math.max(0, ...ghosts.map((g) => g.distance)) * TICK_MS;
    const speed = Math.max(FINALE_MIN_SPEED, longestMs / FINALE_MAX_REPLAY_MS);
    const startsAt = now + FINALE_COUNTDOWN_MS;
    const finale: Finale = { startsAt, speed, endsAt: startsAt + Math.ceil(longestMs / speed) + FINALE_HOLD_MS, ghosts };
    m.status = "finale";
    m.finale = finale;
    this.touch();
  }

  private finish(now: number) {
    const m = this.meta;
    if (m.status !== "finale") return;
    const rows = this.standings();
    for (const { entrant, place } of rows) entrant.place = place;
    m.status = "finished";
    m.finishedAt = now;
    this.touch();
    this.hooks.tournamentFinished(rows.map((r) => ({ userId: r.entrant.userId, place: r.place })));
  }

  // ---------------------------------------------------------------- views

  private me(viewerId: number | null): MyEntry | null {
    if (viewerId === null) return null;
    const m = this.meta;
    const e = m.entrants[viewerId];
    const removed = this.isKicked(viewerId);
    return {
      registered: Boolean(e) && !removed,
      pending: Boolean(m.pending?.[viewerId]),
      removed,
      best: e?.best ? { score: e.best.score, distance: e.best.distance } : null,
      attempts: e?.attempts ?? 0,
      place: m.status === "finished" ? (e?.place ?? null) : null,
    };
  }

  summary(viewerId: number | null, now: number): TournamentSummary {
    const m = this.meta;
    return {
      id: m.id,
      name: m.config.name,
      status: m.status,
      paused: m.paused,
      pauseReason: m.pauseReason,
      startTime: m.config.startTime,
      durationMinutes: m.config.durationMinutes,
      endsAt: m.endsAt,
      remainingMs: m.paused && m.endsAt !== null && m.pausedAt !== null ? Math.max(0, m.endsAt - m.pausedAt) : null,
      entrants: Object.values(m.entrants).filter((e) => !this.isKicked(e.userId)).length,
      maxPlayers: m.config.maxPlayers,
      access: this.access,
      registrationOpen: this.canJoin(now) && this.entrantCount < m.config.maxPlayers,
      me: this.me(viewerId),
    };
  }

  /** What one person sees. Nobody sees anyone else's score until the finale. */
  view(viewerId: number | null, now: number): TournamentView {
    const m = this.meta;
    const started = m.status !== "registering";
    const results: ResultRow[] | null =
      m.status === "finished"
        ? this.standings().map(({ entrant: e, place }) => ({
            userId: e.userId,
            username: e.username,
            avatarUrl: e.avatarUrl,
            place,
            score: e.best?.score ?? null,
            distance: e.best?.distance ?? null,
          }))
        : null;
    return {
      ...this.summary(viewerId, now),
      seed: started && m.status !== "cancelled" ? m.seed : null,
      players: Object.values(m.entrants)
        .filter((e) => !this.isKicked(e.userId))
        .sort((a, b) => a.registeredAt - b.registeredAt)
        .map((e) => ({ userId: e.userId, username: e.username, avatarUrl: e.avatarUrl })),
      finale: m.status === "finale" || m.status === "finished" ? m.finale : null,
      results,
    };
  }
}
