// One multi-table tournament: registration, seating, table balancing, the blind clock, decision
// timers, busts and payouts.
//
// Time never comes from Date.now() in here: every method that depends on time takes `now`, and the
// server calls tick(now) a few times a second. That makes pausing, crash recovery and tests simple.
// All state is plain JSON (meta + one object per table) so it can be saved and restored as-is.

import { shuffledDeck } from "../../shared/engine/cards.ts";
import { type Action, IllegalActionError, applyAction, legalActions, startHand } from "../../shared/engine/hand.ts";
import type { SeatView, TableView, TournamentDetail, TournamentSummary } from "../../shared/protocol.ts";
import { payoutPercents, pointsForPlace } from "./structure.ts";
import type { Entrant, SeatPlayer, TableState, TournamentConfig, TournamentMeta } from "./types.ts";

export class TournamentError extends Error {}

export interface TournamentHooks {
  isConnected(userId: number): boolean;
  tableChanged(tableId: number): void;
  tableClosed(tableId: number): void;
  lobbyChanged(): void;
  playerMoved(userId: number, tableId: number): void;
  playerFinished(userId: number, place: number, points: number): void;
  /** Something needs saving: the meta row, or a table row (deleted = remove it). */
  dirty(what: "meta" | { tableId: number; deleted?: boolean }): void;
}

const noop = () => {};
export const noopHooks: TournamentHooks = {
  isConnected: () => true,
  tableChanged: noop,
  tableClosed: noop,
  lobbyChanged: noop,
  playerMoved: noop,
  playerFinished: noop,
  dirty: noop,
};

/** How long a finished hand's result stays on screen before the next hand. */
export const SHOWDOWN_MS = 4000;
export const UNCONTESTED_MS = 1500;

export interface NewEntrant {
  id: number;
  username: string;
  avatarUrl: string;
}

const occupiedCount = (t: TableState) => t.seats.reduce((n, s) => n + (s ? 1 : 0), 0);

export class Tournament {
  meta: TournamentMeta;
  tables: Map<number, TableState>;
  hooks: TournamentHooks;
  private random: () => number;

  constructor(meta: TournamentMeta, tables: Map<number, TableState>, hooks: TournamentHooks = noopHooks, random = Math.random) {
    this.meta = meta;
    this.tables = tables;
    this.hooks = hooks;
    this.random = random;
  }

  static create(id: number, config: TournamentConfig, now: number, hooks?: TournamentHooks, random?: () => number) {
    const meta: TournamentMeta = {
      id,
      config,
      status: "registering",
      paused: false,
      pauseReason: null,
      pausedAt: null,
      clock: { phase: "level", level: 0, endsAt: null },
      entrants: {},
      remaining: 0,
      nextTableId: 1,
      startedAt: null,
      finishedAt: null,
      savedAt: now,
    };
    return new Tournament(meta, new Map(), hooks, random);
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

  // ---------------------------------------------------------------- registration

  lateRegOpen(): boolean {
    const m = this.meta;
    if (m.status === "registering") return true;
    return m.status === "running" && m.clock.level < m.config.lateRegLevels;
  }

  register(user: NewEntrant, now: number) {
    const m = this.meta;
    if (!this.lateRegOpen()) throw new TournamentError("Registration is closed");
    if (m.entrants[user.id]) throw new TournamentError("You are already registered");
    if (this.entrantCount >= m.config.maxPlayers) throw new TournamentError("The tournament is full");
    const e: Entrant = {
      userId: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      registeredAt: now,
      tableId: null,
      place: null,
      points: 0,
    };
    m.entrants[user.id] = e;
    if (m.status === "running") this.seatLatePlayer(e);
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();
  }

  unregister(userId: number) {
    if (this.meta.status !== "registering") throw new TournamentError("You can't unregister once the tournament has started");
    if (!this.meta.entrants[userId]) throw new TournamentError("You are not registered");
    delete this.meta.entrants[userId];
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();
  }

  // ---------------------------------------------------------------- lifecycle

  start(now: number) {
    const m = this.meta;
    if (m.status !== "registering") throw new TournamentError("The tournament has already started");
    const ids = this.shuffle(Object.keys(m.entrants).map(Number));
    if (ids.length < 2) throw new TournamentError("At least two players must be registered to start");

    const tableCount = Math.ceil(ids.length / m.config.tableSize);
    const tables = Array.from({ length: tableCount }, () => this.newTable());
    ids.forEach((userId, i) => this.placeAt(tables[i % tableCount]!, this.newSeatPlayer(userId)));
    for (const t of tables) {
      const occupied = t.seats.flatMap((s, i) => (s ? [i] : []));
      t.button = occupied[Math.floor(this.random() * occupied.length)]!;
    }

    m.status = "running";
    m.startedAt = now;
    m.remaining = ids.length;
    m.paused = false;
    m.pauseReason = null;
    m.pausedAt = null;
    m.clock = { phase: "level", level: 0, endsAt: now + m.config.levels[0]!.minutes * 60_000 };
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();
  }

  pause(reason: string, now: number) {
    const m = this.meta;
    if (m.status !== "running") throw new TournamentError("The tournament is not running");
    if (m.paused) throw new TournamentError("Already paused");
    m.paused = true;
    m.pauseReason = reason;
    m.pausedAt = now;
    this.touchAll();
  }

  /** Continues every timer from exactly where it was when the pause began. */
  resume(now: number) {
    const m = this.meta;
    if (!m.paused || m.pausedAt === null) throw new TournamentError("The tournament is not paused");
    const shift = now - m.pausedAt;
    if (m.clock.endsAt !== null) m.clock.endsAt += shift;
    for (const t of this.tables.values()) {
      if (t.actionStartedAt !== null) t.actionStartedAt += shift;
      if (t.handDoneAt !== null) t.handDoneAt += shift;
    }
    m.paused = false;
    m.pauseReason = null;
    m.pausedAt = null;
    this.touchAll();
  }

  /** After loading from disk: a tournament that was running comes back paused at the moment it was last saved. */
  restoreAfterRestart() {
    const m = this.meta;
    if (m.status === "running" && !m.paused) {
      m.paused = true;
      m.pausedAt = m.savedAt;
      m.pauseReason = "The server restarted. An admin needs to resume the tournament.";
      this.hooks.dirty("meta");
    }
  }

  cancel(now: number) {
    const m = this.meta;
    if (m.status === "finished" || m.status === "cancelled") throw new TournamentError("The tournament is already over");
    m.status = "cancelled";
    m.finishedAt = now;
    m.paused = false;
    this.closeAllTables();
    for (const e of Object.values(m.entrants)) e.tableId = null;
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();
  }

  /** Removes a player. If they're in a hand they fold out of it first. */
  kick(userId: number) {
    const loc = this.locate(userId);
    if (!loc) throw new TournamentError("That player is not seated");
    if (!loc.table.hand) {
      this.bust(loc.table, [loc.seatIdx], new Map());
      this.touchTable(loc.table);
    } else {
      loc.seat.leaving = true;
      loc.seat.away = true;
      this.touchTable(loc.table);
    }
  }

  setAway(userId: number, away: boolean) {
    const loc = this.locate(userId);
    if (!loc) throw new TournamentError("You are not seated");
    if (loc.seat.leaving) return;
    loc.seat.away = away;
    this.touchTable(loc.table);
  }

  // ---------------------------------------------------------------- playing

  act(userId: number, action: Action, now: number) {
    const m = this.meta;
    if (m.status !== "running") throw new TournamentError("The tournament is not running");
    if (m.paused) throw new TournamentError("The tournament is paused");
    const loc = this.locate(userId);
    if (!loc) throw new TournamentError("You are not seated");
    const { table, seat } = loc;
    const hand = table.hand;
    if (!hand || hand.toAct === null || hand.players[hand.toAct]!.playerId !== String(userId) || seat.leaving)
      throw new TournamentError("It's not your turn");

    // Time past the normal decision window comes out of the time bank.
    const overflow = Math.max(0, now - (table.actionStartedAt ?? now) - this.config.decisionSeconds * 1000);
    seat.timeBankMs = Math.max(0, seat.timeBankMs - overflow);
    seat.away = false;
    this.applyHand(table, userId, action, now);
  }

  tick(now: number) {
    const m = this.meta;
    if (m.status === "registering" && !m.paused && now >= m.config.startTime && this.entrantCount >= 2) this.start(now);
    if (m.status !== "running" || m.paused) return;

    this.advanceClock(now);
    for (const t of [...this.tables.values()]) this.tickTable(t, now);
    this.rebalance();

    if (m.remaining <= 1) {
      this.finish(now);
      return;
    }
    if (m.clock.phase !== "break") for (const t of this.tables.values()) if (!t.hand) this.startNextHand(t, now);

    // Keep savedAt fresh so a crash resumes from close to the right moment.
    if (now - m.savedAt > 5000) this.hooks.dirty("meta");
  }

  private tickTable(t: TableState, now: number) {
    if (!t.hand) return;
    if (t.hand.street === "complete") {
      if (t.handDoneAt !== null && now >= t.handDoneAt) this.finishHand(t);
      return;
    }
    const decisionMs = this.config.decisionSeconds * 1000;
    for (let guard = 0; guard < 100 && t.hand && t.hand.toAct !== null; guard++) {
      const hp = t.hand.players[t.hand.toAct]!;
      const seat = t.seats[hp.seat]!;
      if (!seat.away && !seat.leaving) {
        // Disconnected players get the normal decision time but don't burn their time bank.
        const connected = this.hooks.isConnected(seat.userId);
        const deadline = (t.actionStartedAt ?? now) + decisionMs + (connected ? seat.timeBankMs : 0);
        if (now < deadline) break;
        if (connected) seat.timeBankMs = 0;
        seat.away = true;
      }
      const legal = legalActions(t.hand)!;
      this.applyHand(t, seat.userId, legal.canCheck && !seat.leaving ? { type: "check" } : { type: "fold" }, now);
    }
  }

  private applyHand(t: TableState, userId: number, action: Action, now: number) {
    try {
      t.hand = applyAction(t.hand!, String(userId), action);
    } catch (err) {
      if (err instanceof IllegalActionError) throw new TournamentError(err.message);
      throw err;
    }
    this.afterHandChange(t, now);
  }

  private afterHandChange(t: TableState, now: number) {
    const h = t.hand!;
    if (h.street === "complete") {
      t.actionStartedAt = null;
      t.handDoneAt = now + (h.result!.showdown.length ? SHOWDOWN_MS : UNCONTESTED_MS);
    } else {
      t.actionStartedAt = now;
    }
    this.touchTable(t);
  }

  private startNextHand(t: TableState, now: number) {
    const occupied = t.seats.filter((s) => s && s.chips > 0).length;
    if (occupied < 2) return;
    const level = this.config.levels[this.meta.clock.level]!;
    t.button = this.nextOccupied(t, t.button);
    t.hand = startHand(
      {
        seats: t.seats.map((s) => (s && s.chips > 0 ? { playerId: String(s.userId), stack: s.chips } : null)),
        button: t.button,
        smallBlind: level.smallBlind,
        bigBlind: level.bigBlind,
        ante: level.ante,
      },
      shuffledDeck(),
    );
    t.handNo++;
    this.afterHandChange(t, now);
  }

  private finishHand(t: TableState) {
    const h = t.hand!;
    const before = new Map<number, number>();
    for (const p of h.players) {
      const seat = t.seats[p.seat]!;
      before.set(p.seat, seat.chips);
      seat.chips = p.stack;
    }
    t.hand = null;
    t.handDoneAt = null;
    t.actionStartedAt = null;
    const out = t.seats.flatMap((s, i) => (s && (s.chips === 0 || s.leaving) ? [i] : []));
    this.bust(t, out, before);
    this.touchTable(t);
  }

  /** Removes players from their seats and gives them finishing places. Smaller starting stacks finish lower. */
  private bust(t: TableState, seatIdxs: number[], startStacks: Map<number, number>) {
    if (!seatIdxs.length) return;
    const m = this.meta;
    const start = (i: number) => startStacks.get(i) ?? t.seats[i]!.chips;
    for (const i of [...seatIdxs].sort((a, b) => start(a) - start(b))) {
      const seat = t.seats[i]!;
      t.seats[i] = null;
      const e = m.entrants[seat.userId]!;
      e.tableId = null;
      e.place = m.remaining;
      e.points = pointsForPlace(e.place, this.entrantCount, m.config.payoutPercent);
      m.remaining--;
      this.hooks.playerFinished(e.userId, e.place, e.points);
    }
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();
  }

  private finish(now: number) {
    const m = this.meta;
    const winner = Object.values(m.entrants).find((e) => e.place === null && e.tableId !== null);
    if (winner) {
      winner.place = 1;
      winner.tableId = null;
      winner.points = pointsForPlace(1, this.entrantCount, m.config.payoutPercent);
      this.hooks.playerFinished(winner.userId, 1, winner.points);
    }
    m.remaining = 0;
    m.status = "finished";
    m.finishedAt = now;
    this.closeAllTables();
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();
  }

  // ---------------------------------------------------------------- clock

  private advanceClock(now: number) {
    const { levels, breakEveryLevels, breakMinutes } = this.config;
    const c = this.meta.clock;
    let changed = false;
    while (c.endsAt !== null && now >= c.endsAt) {
      const end = c.endsAt;
      changed = true;
      if (c.phase === "level") {
        if (c.level >= levels.length - 1) {
          c.endsAt = null; // final level lasts until the end
          break;
        }
        if (breakEveryLevels > 0 && breakMinutes > 0 && (c.level + 1) % breakEveryLevels === 0) {
          c.phase = "break";
          c.endsAt = end + breakMinutes * 60_000;
          continue;
        }
      }
      c.phase = "level";
      c.level++;
      c.endsAt = end + levels[c.level]!.minutes * 60_000;
      this.refillTimeBanks();
    }
    if (changed) this.touchAll();
  }

  private refillTimeBanks() {
    const { timeBankSeconds, timeBankRefillSeconds } = this.config;
    for (const t of this.tables.values())
      for (const s of t.seats) if (s) s.timeBankMs = Math.min(timeBankSeconds * 1000, s.timeBankMs + timeBankRefillSeconds * 1000);
  }

  // ---------------------------------------------------------------- seating and balancing

  private newTable(): TableState {
    const t: TableState = {
      id: this.meta.nextTableId++,
      seats: Array.from({ length: this.config.tableSize }, () => null),
      button: -1,
      hand: null,
      handNo: 0,
      actionStartedAt: null,
      handDoneAt: null,
    };
    this.tables.set(t.id, t);
    this.hooks.dirty({ tableId: t.id });
    return t;
  }

  private newSeatPlayer(userId: number): SeatPlayer {
    return {
      userId,
      chips: this.config.startingStack,
      away: false,
      leaving: false,
      timeBankMs: this.config.timeBankSeconds * 1000,
    };
  }

  /** Puts a player in a random empty seat. Players joining mid-hand are dealt in from the next hand. */
  private placeAt(t: TableState, seat: SeatPlayer) {
    const free = t.seats.flatMap((s, i) => (s ? [] : [i]));
    if (!free.length) throw new Error(`Table ${t.id} is full`);
    t.seats[free[Math.floor(this.random() * free.length)]!] = seat;
    this.meta.entrants[seat.userId]!.tableId = t.id;
    this.hooks.playerMoved(seat.userId, t.id);
    this.touchTable(t);
  }

  private seatLatePlayer(e: Entrant) {
    const size = this.config.tableSize;
    const open = [...this.tables.values()].filter((t) => occupiedCount(t) < size).sort((a, b) => occupiedCount(a) - occupiedCount(b) || a.id - b.id);
    this.placeAt(open[0] ?? this.newTable(), this.newSeatPlayer(e.userId));
    this.meta.remaining++;
  }

  /**
   * Keeps the field on as few tables as possible and evenly spread. Only moves players from tables
   * that are between hands; tables in a hand can always receive players.
   */
  rebalance() {
    const size = this.config.tableSize;
    const needed = Math.max(1, Math.ceil(this.meta.remaining / size));

    // 1. Break the smallest table (highest number on ties) once the others have room for its players.
    while (this.tables.size > needed) {
      const victim = [...this.tables.values()].sort((a, b) => occupiedCount(a) - occupiedCount(b) || b.id - a.id)[0]!;
      if (victim.hand) break; // wait for its hand to finish
      const others = [...this.tables.values()].filter((t) => t !== victim);
      const free = others.reduce((n, t) => n + size - occupiedCount(t), 0);
      if (free < occupiedCount(victim)) break;
      victim.seats.forEach((s, i) => {
        if (!s) return;
        victim.seats[i] = null;
        const target = others.filter((t) => occupiedCount(t) < size).sort((a, b) => occupiedCount(a) - occupiedCount(b) || a.id - b.id)[0]!;
        this.placeAt(target, s);
      });
      this.tables.delete(victim.id);
      this.hooks.tableClosed(victim.id);
      this.hooks.dirty({ tableId: victim.id, deleted: true });
    }

    // 2. Move players from the biggest idle table to the smallest until no table has 2+ more than another.
    for (let guard = 0; guard < 10_000; guard++) {
      const all = [...this.tables.values()];
      if (all.length < 2) break;
      const smallest = all.reduce((a, b) => (occupiedCount(b) < occupiedCount(a) ? b : a));
      const donor = all
        .filter((t) => !t.hand && occupiedCount(t) - occupiedCount(smallest) >= 2)
        .sort((a, b) => occupiedCount(b) - occupiedCount(a))[0];
      if (!donor) break;
      // Move the player who would be big blind next, so nobody skips paying blinds by moving.
      const btn = this.nextOccupied(donor, donor.button);
      const bb = this.nextOccupied(donor, this.nextOccupied(donor, btn));
      const seat = donor.seats[bb]!;
      donor.seats[bb] = null;
      this.touchTable(donor);
      this.placeAt(smallest, seat);
    }
  }

  private nextOccupied(t: TableState, from: number): number {
    const n = t.seats.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + k) % n) + n) % n;
      if (t.seats[i]) return i;
    }
    return -1;
  }

  private closeAllTables() {
    for (const id of this.tables.keys()) {
      this.hooks.tableClosed(id);
      this.hooks.dirty({ tableId: id, deleted: true });
    }
    this.tables.clear();
  }

  // ---------------------------------------------------------------- helpers

  locate(userId: number) {
    const e = this.meta.entrants[userId];
    if (!e || e.tableId === null) return null;
    const table = this.tables.get(e.tableId);
    if (!table) return null;
    const seatIdx = table.seats.findIndex((s) => s?.userId === userId);
    if (seatIdx < 0) return null;
    return { table, seat: table.seats[seatIdx]!, seatIdx };
  }

  private touchTable(t: TableState) {
    this.hooks.dirty({ tableId: t.id });
    this.hooks.tableChanged(t.id);
  }

  private touchAll() {
    this.hooks.dirty("meta");
    for (const t of this.tables.values()) this.touchTable(t);
    this.hooks.lobbyChanged();
  }

  private shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  }

  /** Total chips in play (for tests and sanity checks). */
  chipsInPlay(): number {
    let total = 0;
    for (const t of this.tables.values()) {
      const inHand = new Map(t.hand?.players.map((p) => [p.seat, p]));
      t.seats.forEach((s, i) => {
        if (!s) return;
        const p = inHand.get(i);
        total += p ? p.stack + (t.hand!.result ? 0 : p.contributed) : s.chips;
      });
    }
    return total;
  }

  // ---------------------------------------------------------------- views

  summary(viewerId: number | null): TournamentSummary {
    const m = this.meta;
    const { levels } = m.config;
    const c = m.clock;
    const level = Math.min(c.level, levels.length - 1);
    const e = viewerId === null ? undefined : m.entrants[viewerId];
    return {
      id: m.id,
      name: m.config.name,
      status: m.status,
      paused: m.paused,
      pauseReason: m.pauseReason,
      startTime: m.config.startTime,
      entrants: this.entrantCount,
      remaining: m.remaining,
      maxPlayers: m.config.maxPlayers,
      startingStack: m.config.startingStack,
      phase: c.phase,
      level,
      levelInfo: levels[level]!,
      nextLevelInfo: levels[level + 1] ?? null,
      phaseEndsAt: m.status === "running" && !m.paused ? c.endsAt : null,
      phaseRemainingMs: m.paused && c.endsAt !== null && m.pausedAt !== null ? c.endsAt - m.pausedAt : null,
      lateRegOpen: this.lateRegOpen(),
      me:
        viewerId === null
          ? null
          : e
            ? { registered: true, tableId: e.tableId, place: e.place, points: e.points }
            : { registered: false, tableId: null, place: null, points: 0 },
    };
  }

  tableView(tableId: number, viewerId: number | null, now: number): TableView | null {
    const t = this.tables.get(tableId);
    if (!t) return null;
    const m = this.meta;
    const h = t.hand;
    const decisionMs = m.config.decisionSeconds * 1000;
    const inHand = new Map(h?.players.map((p) => [p.seat, p]));
    const revealed = new Map(h?.result?.showdown.map((s) => [s.playerId, s]));
    const payouts = h?.result?.payouts ?? {};

    // Each player's most recent action on the current street.
    const lastAction = new Map<string, string>();
    let streetBet = h?.bigBlind ?? 0;
    for (const ev of h?.log ?? []) {
      if (ev.type === "street") {
        lastAction.clear();
        streetBet = 0;
      } else if (ev.type === "action") {
        const a = ev.action;
        lastAction.set(
          ev.playerId,
          ev.allIn && a.type !== "fold" && a.type !== "check"
            ? "All-in"
            : a.type === "raise"
              ? `${streetBet === 0 ? "Bet" : "Raise to"} ${a.to.toLocaleString()}`
              : a.type[0]!.toUpperCase() + a.type.slice(1),
        );
        if (a.type === "raise") streetBet = a.to;
      }
    }

    const toActSeat = h && h.toAct !== null ? h.players[h.toAct]!.seat : null;
    let actionDeadline: number | null = null;
    if (toActSeat !== null && t.actionStartedAt !== null) {
      const s = t.seats[toActSeat]!;
      actionDeadline = t.actionStartedAt + decisionMs + (this.hooks.isConnected(s.userId) ? s.timeBankMs : 0);
    }
    const legal = h && viewerId !== null ? legalActions(h) : null;

    const seats = t.seats.map((s, i): SeatView | null => {
      if (!s) return null;
      const e = m.entrants[s.userId]!;
      const p = inHand.get(i);
      const pid = String(s.userId);
      const shown = revealed.get(pid);
      return {
        seat: i,
        userId: s.userId,
        username: e.username,
        avatarUrl: e.avatarUrl,
        chips: p ? p.stack : s.chips,
        bet: p?.bet ?? 0,
        inHand: Boolean(p),
        folded: p?.folded ?? false,
        allIn: p?.allIn ?? false,
        away: s.away,
        connected: this.hooks.isConnected(s.userId),
        holeCards: !p || p.folded ? [] : s.userId === viewerId || shown ? p.holeCards : p.holeCards.map(() => "??"),
        lastAction: lastAction.get(pid) ?? null,
        won: payouts[pid] ?? 0,
        handName: shown?.handName ?? null,
        timeBankMs: s.timeBankMs,
      };
    });

    const complete = h?.street === "complete";
    return {
      tournamentId: m.id,
      tableId: t.id,
      tableSize: m.config.tableSize,
      seats,
      button: t.button,
      handNo: t.handNo,
      street: h?.street ?? null,
      board: h?.board ?? [],
      pot: h && !complete ? h.players.reduce((n, p) => n + p.contributed - p.bet, 0) : 0,
      currentBet: h?.currentBet ?? 0,
      toActSeat,
      actionStartedAt: t.actionStartedAt,
      decisionMs,
      actionDeadline,
      level: m.config.levels[Math.min(m.clock.level, m.config.levels.length - 1)]!,
      legal: legal && legal.playerId === String(viewerId) && !m.paused ? legal : null,
      mySeat: viewerId === null ? null : (() => {
        const i = t.seats.findIndex((s) => s?.userId === viewerId);
        return i < 0 ? null : i;
      })(),
      handComplete: complete,
      paused: m.paused,
      onBreak: m.clock.phase === "break",
      serverNow: now,
    };
  }

  detail(viewerId: number | null): TournamentDetail {
    const m = this.meta;
    const entrants = this.entrantCount;
    const chips = new Map<number, number>();
    for (const t of this.tables.values()) for (const s of t.seats) if (s) chips.set(s.userId, s.chips);
    const all = Object.values(m.entrants);
    const alive = all.filter((e) => e.place === null && e.tableId !== null).sort((a, b) => (chips.get(b.userId) ?? 0) - (chips.get(a.userId) ?? 0));
    const out = all.filter((e) => e.place !== null).sort((a, b) => a.place! - b.place!);
    const totalChips = [...chips.values()].reduce((a, b) => a + b, 0);
    return {
      summary: this.summary(viewerId),
      levels: m.config.levels,
      breakEveryLevels: m.config.breakEveryLevels,
      breakMinutes: m.config.breakMinutes,
      lateRegLevels: m.config.lateRegLevels,
      payouts: payoutPercents(entrants, m.config.payoutPercent).map((percent, i) => ({
        place: i + 1,
        percent,
        points: Math.round(percent * entrants),
      })),
      tables: [...this.tables.values()].sort((a, b) => a.id - b.id).map((t) => ({ id: t.id, players: occupiedCount(t), handNo: t.handNo })),
      standings: [...alive, ...out].slice(0, 300).map((e) => ({
        userId: e.userId,
        username: e.username,
        chips: chips.get(e.userId) ?? 0,
        place: e.place,
        points: e.points,
        tableId: e.tableId,
      })),
      averageStack: m.remaining ? Math.round(totalChips / m.remaining) : 0,
    };
  }
}
