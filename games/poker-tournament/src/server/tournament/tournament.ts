// One 6-max shootout tournament.
//
// Players are drawn to round-1 tables of up to six. Each table plays until one player has all the
// chips; that winner advances. Tables are grouped in sixes like a bracket: when all six tables in a
// group have a winner, those winners start a new table together, each with a fresh starting stack and
// the blinds back at level 1. This repeats until one final table produces the champion. Tables never
// merge or rebalance, so nobody ever arrives at a table with more chips than anyone else.
//
// Time never comes from Date.now() in here: every method that depends on time takes `now`, and the
// server calls tick(now) a few times a second. That makes pausing, crash recovery and tests simple.
// All state is plain JSON (meta + one object per table) so it can be saved and restored as-is.

import { type Card, shuffledDeck } from "../../shared/engine/cards.ts";
import {
  type Action,
  type HandState,
  IllegalActionError,
  applyAction,
  legalActions,
  rabbitResult,
  runout,
  startHand,
} from "../../shared/engine/hand.ts";
import type { SeatView, TableView, TournamentDetail, TournamentSummary } from "../../shared/protocol.ts";
import { bracketShape, evenSplit, payoutPercents, payoutPoints, pointsForPlace } from "./structure.ts";
import type { BracketNode, Clock, SeatPlayer, TableState, TournamentConfig, TournamentMeta, LobbyAccess } from "./types.ts";

export class TournamentError extends Error {}

export interface TournamentHooks {
  isConnected(userId: number): boolean;
  tableChanged(tableId: number): void;
  /** winnerId: who won the table and moves on (null when nobody did, or the tournament ended). */
  tableClosed(tableId: number, winnerId: number | null): void;
  /** People watching a table who aren't seated at it. */
  viewerCount(tableId: number): number;
  lobbyChanged(): void;
  playerMoved(userId: number, tableId: number): void;
  playerAdvanced(userId: number, round: number): void;
  playerFinished(userId: number, place: number, points: number): void;
  /** The tournament produced its champion (not called on cancel). */
  tournamentFinished(): void;
  /** A hand just ended: who won what, as lines for the table chat. */
  handComplete(tableId: number, lines: string[]): void;
  /** Something needs saving: the meta row, or a table row (deleted = remove it). */
  dirty(what: "meta" | { tableId: number; deleted?: boolean }): void;
}

const noop = () => {};
export const noopHooks: TournamentHooks = {
  isConnected: () => true,
  tableChanged: noop,
  tableClosed: noop,
  viewerCount: () => 0,
  lobbyChanged: noop,
  playerMoved: noop,
  playerAdvanced: noop,
  playerFinished: noop,
  tournamentFinished: noop,
  handComplete: noop,
  dirty: noop,
};

/** How long a finished hand's result stays on screen before the next hand. */
export const SHOWDOWN_MS = 4000;
export const UNCONTESTED_MS = 1500;
/** An uncontested hand with rabbit hunt cards to show: long enough to see them. */
export const RABBIT_MS = 3000;

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
  /** Deck for each new hand. Tests pass a stacked one. */
  private deck: () => Card[];

  constructor(
    meta: TournamentMeta,
    tables: Map<number, TableState>,
    hooks: TournamentHooks = noopHooks,
    random = Math.random,
    deck: () => Card[] = shuffledDeck,
  ) {
    this.meta = meta;
    this.tables = tables;
    this.hooks = hooks;
    this.random = random;
    this.deck = deck;
  }

  static create(id: number, config: TournamentConfig, now: number, hooks?: TournamentHooks, random?: () => number, deck?: () => Card[]) {
    const meta: TournamentMeta = {
      id,
      config,
      status: "registering",
      paused: false,
      pauseReason: null,
      pausedAt: null,
      entrants: {},
      remaining: 0,
      bracket: [],
      totalRounds: 0,
      roundBlocks: [],
      startedAt: null,
      finishedAt: null,
      savedAt: now,
    };
    return new Tournament(meta, new Map(), hooks, random, deck);
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

  register(user: NewEntrant, now: number) {
    const m = this.meta;
    if (m.status !== "registering") throw new TournamentError("Registration is closed");
    if (m.entrants[user.id]) throw new TournamentError("You are already registered");
    if (m.kicked?.includes(user.id)) throw new TournamentError("An admin removed you from this tournament");
    if (this.access === "closed") {
      if (m.pending?.[user.id]) throw new TournamentError("You already asked to join. An admin will let you in.");
      if (this.entrantCount >= m.config.maxPlayers) throw new TournamentError("The tournament is full");
      (m.pending ??= {})[user.id] = { userId: user.id, username: user.username, avatarUrl: user.avatarUrl, requestedAt: now };
      this.hooks.dirty("meta");
      this.hooks.lobbyChanged();
      return;
    }
    this.admit(user, now);
  }

  /** Adds a player to the field: an open registration, or an admin approving their request. */
  private admit(user: NewEntrant, now: number) {
    const m = this.meta;
    if (this.entrantCount >= m.config.maxPlayers) throw new TournamentError("The tournament is full");
    m.entrants[user.id] = {
      userId: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      registeredAt: now,
      tableId: null,
      round: 0,
      advancedTo: null,
      place: null,
      points: 0,
    };
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();
  }

  unregister(userId: number) {
    // Withdrawing a join request.
    if (this.meta.pending?.[userId]) {
      delete this.meta.pending[userId];
      this.hooks.dirty("meta");
      this.hooks.lobbyChanged();
      return;
    }
    if (this.meta.status !== "registering") throw new TournamentError("You can't unregister once the tournament has started");
    if (!this.meta.entrants[userId]) throw new TournamentError("You are not registered");
    delete this.meta.entrants[userId];
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();
  }

  get access(): LobbyAccess {
    return this.meta.access ?? "open";
  }

  /** Opening the lobby lets in everyone who was waiting, while there's room. */
  setAccess(access: LobbyAccess, now: number) {
    const m = this.meta;
    if (m.status === "finished" || m.status === "cancelled") throw new TournamentError("The tournament is already over");
    m.access = access;
    if (access === "open" && m.status === "registering") {
      for (const p of Object.values(m.pending ?? {}).sort((a, b) => a.requestedAt - b.requestedAt)) {
        if (this.entrantCount >= m.config.maxPlayers) break;
        this.admit({ id: p.userId, username: p.username, avatarUrl: p.avatarUrl }, now);
        delete m.pending![p.userId];
      }
    }
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();
  }

  /** Lets someone who asked to join into the tournament (admin). */
  approve(userId: number, now: number) {
    const m = this.meta;
    const p = m.pending?.[userId];
    if (!p) throw new TournamentError("That player hasn't asked to join");
    if (m.status !== "registering") throw new TournamentError("Registration is closed");
    this.admit({ id: p.userId, username: p.username, avatarUrl: p.avatarUrl }, now);
    delete m.pending![userId];
    this.hooks.dirty("meta");
  }

  /** Turns down a join request (admin). They can ask again. */
  deny(userId: number) {
    if (!this.meta.pending?.[userId]) throw new TournamentError("That player hasn't asked to join");
    delete this.meta.pending[userId];
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();
  }

  /**
   * Removes a player (admin) and stops them registering again. Before the start they leave the field;
   * once it's running they're knocked out at their table, or as soon as they reach their next one.
   */
  kick(userId: number, now: number) {
    const m = this.meta;
    if (m.status === "finished" || m.status === "cancelled") throw new TournamentError("The tournament is already over");
    const e = m.entrants[userId];
    const asked = Boolean(m.pending?.[userId]);
    if (!e && !asked) throw new TournamentError("That player isn't in this tournament");
    if (m.kicked?.includes(userId)) throw new TournamentError("That player was already kicked");
    if (e && e.place !== null) throw new TournamentError("That player is already out");
    if (!(m.kicked ??= []).includes(userId)) m.kicked.push(userId);
    if (asked) delete m.pending![userId];
    if (e && m.status === "registering") delete m.entrants[userId];
    else if (e && this.locate(userId)) this.removeSeated(userId, now);
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();
  }

  // ---------------------------------------------------------------- lifecycle

  /** Draws the bracket and seats round 1. */
  start(now: number) {
    const m = this.meta;
    if (m.status !== "registering") throw new TournamentError("The tournament has already started");
    const ids = this.shuffle(Object.keys(m.entrants).map(Number));
    if (ids.length < 2) throw new TournamentError("At least two players must be registered to start");

    // Build the bracket: round 1 tables first, then each round's tables take an even share of the
    // previous round's tables as children.
    const shape = bracketShape(ids.length, m.config.tableSize);
    const bracket: BracketNode[] = [];
    let prev: BracketNode[] = [];
    shape.forEach((count, r) => {
      const round: BracketNode[] = [];
      const childCounts = r === 0 ? [] : evenSplit(prev.length, count);
      let next = 0;
      for (let i = 0; i < count; i++) {
        const node: BracketNode = { id: bracket.length + 1, round: r + 1, parent: null, children: [], players: [], done: false, winner: null };
        bracket.push(node);
        round.push(node);
        if (r > 0) {
          for (const child of prev.slice(next, next + childCounts[i]!)) {
            child.parent = node.id;
            node.children.push(child.id);
          }
          next += childCounts[i]!;
        }
      }
      prev = round;
    });
    const firstRound = bracket.filter((n) => n.round === 1);
    ids.forEach((userId, i) => firstRound[i % firstRound.length]!.players.push(userId));

    // Each round's knockouts take a block of finishing places, worst first.
    m.roundBlocks = [];
    let worst = ids.length;
    shape.forEach((tables, r) => {
      m.roundBlocks.push({ worst, eliminated: 0 });
      const playersInRound = r === 0 ? ids.length : shape[r - 1]!;
      worst -= playersInRound - tables;
    });

    m.bracket = bracket;
    m.totalRounds = shape.length;
    m.status = "running";
    m.startedAt = now;
    m.remaining = ids.length;
    m.paused = false;
    m.pauseReason = null;
    m.pausedAt = null;
    for (const e of Object.values(m.entrants)) e.round = 1;
    for (const node of firstRound) this.openTable(node, now);
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
    for (const t of this.tables.values()) {
      if (t.clock.endsAt !== null) t.clock.endsAt += shift;
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
    for (const e of Object.values(m.entrants)) {
      e.tableId = null;
      e.advancedTo = null;
    }
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();
  }

  /** Removes a seated player. If they're in a hand they fold out of it first. */
  private removeSeated(userId: number, now: number) {
    const loc = this.locate(userId);
    if (!loc) throw new TournamentError("That player is not seated");
    if (!loc.table.hand) {
      this.bust(loc.table, [loc.seatIdx], new Map());
      this.touchTable(loc.table);
      this.checkTableOver(loc.table, now);
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

    // Players removed while waiting for their next table leave as soon as they're seated there.
    for (const id of m.kicked ?? []) {
      const loc = this.locate(id);
      if (loc && !(loc.seat as { leaving?: boolean }).leaving) this.removeSeated(id, now);
    }

    for (const t of [...this.tables.values()]) {
      this.advanceClock(t, now);
      this.tickTable(t, now);
    }
    if (m.status !== "running") return; // the final table may have just finished
    for (const t of this.tables.values()) if (!t.hand && t.clock.phase !== "break") this.startNextHand(t, now);

    // Keep savedAt fresh so a crash resumes from close to the right moment.
    if (now - m.savedAt > 5000) this.hooks.dirty("meta");
  }

  private tickTable(t: TableState, now: number) {
    if (!t.hand) return;
    if (t.hand.street === "complete") {
      if (t.handDoneAt !== null && now >= t.handDoneAt) this.finishHand(t, now);
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
      t.handDoneAt = now + (h.result!.showdown.length ? SHOWDOWN_MS : this.rabbitCards(h).length ? RABBIT_MS : UNCONTESTED_MS);
      this.hooks.handComplete(t.id, this.handSummary(t));
    } else {
      t.actionStartedAt = now;
    }
    this.touchTable(t);
  }

  /** The rabbit hunt cards for a finished hand, when the setting is on (missing on older tournaments: on). */
  private rabbitCards(h: HandState) {
    return this.config.rabbitHunt === false ? [] : runout(h);
  }

  /** "Bot 3 wins 1,250 with Two Pair" for each winner of the hand that just ended. */
  handSummary(t: TableState): string[] {
    const r = t.hand?.result;
    if (!r) return [];
    const name = (pid: string) => this.meta.entrants[pid]?.username ?? "Someone";
    const shown = new Map(r.showdown.map((s) => [s.playerId, s.handName]));
    return Object.entries(r.payouts)
      .filter(([, amount]) => amount > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([pid, amount]) => `Hand #${t.handNo}: ${name(pid)} wins ${amount.toLocaleString("en-US")}${shown.get(pid) ? ` with ${shown.get(pid)}` : ""}`);
  }

  private startNextHand(t: TableState, now: number) {
    if (occupiedCount(t) < 2) return;
    const level = this.config.levels[t.clock.level]!;
    t.button = this.nextOccupied(t, t.button);
    t.hand = startHand(
      {
        seats: t.seats.map((s) => (s ? { playerId: String(s.userId), stack: s.chips } : null)),
        button: t.button,
        smallBlind: level.smallBlind,
        bigBlind: level.bigBlind,
        ante: level.ante,
      },
      this.deck(),
    );
    t.handNo++;
    this.afterHandChange(t, now);
  }

  private finishHand(t: TableState, now: number) {
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
    this.checkTableOver(t, now);
  }

  /** Removes players from their seats and gives them finishing places within their round's block. */
  private bust(t: TableState, seatIdxs: number[], startStacks: Map<number, number>) {
    if (!seatIdxs.length) return;
    const m = this.meta;
    const block = m.roundBlocks[t.round - 1]!;
    // Several knocked out in one hand: whoever started the hand with fewer chips finishes lower.
    const start = (i: number) => startStacks.get(i) ?? t.seats[i]!.chips;
    for (const i of [...seatIdxs].sort((a, b) => start(a) - start(b))) {
      const seat = t.seats[i]!;
      t.seats[i] = null;
      const e = m.entrants[seat.userId]!;
      e.tableId = null;
      e.place = Math.max(1, block.worst - block.eliminated++);
      e.points = pointsForPlace(e.place, this.entrantCount, m.config.payoutPercent);
      m.remaining--;
      this.hooks.playerFinished(e.userId, e.place, e.points);
    }
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();
  }

  // ---------------------------------------------------------------- bracket

  /** A table is over when one player is left (they advance) or nobody is (everyone was removed). */
  private checkTableOver(t: TableState, now: number) {
    if (t.hand) return;
    const left = t.seats.filter((s): s is SeatPlayer => s !== null);
    if (left.length > 1) return;
    this.closeTable(t.id, left[0]?.userId ?? null);
    this.completeNode(this.node(t.id), left[0]?.userId ?? null, now, left[0]?.chips);
  }

  /** Records a table's winner and moves them up the bracket, with the chips they finished on. */
  private completeNode(node: BracketNode, winner: number | null, now: number, chips?: number) {
    const m = this.meta;
    node.done = true;
    node.winner = winner;
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();

    if (node.parent === null) {
      this.finish(now, winner);
      return;
    }
    const parent = this.node(node.parent);
    if (winner !== null) {
      const e = m.entrants[winner]!;
      e.tableId = null;
      e.advancedTo = parent.id;
      e.round = parent.round;
      if (chips !== undefined) e.carryChips = chips;
      parent.players.push(winner);
      this.hooks.playerAdvanced(winner, parent.round);
    }
    if (!parent.children.every((c) => this.node(c).done)) return;

    // Whole group done. Normally that's a new table; if only one winner came through, they advance again.
    if (parent.players.length >= 2) this.openTable(parent, now);
    else this.completeNode(parent, parent.players[0] ?? null, now, parent.players[0] !== undefined ? m.entrants[parent.players[0]]!.carryChips : undefined);
  }

  /** What a player sits down with: the starting stack (Fair Play), or what they won (Full-on Bullying). */
  private stackFor(userId: number) {
    const m = this.meta;
    if (m.config.chipMode !== "bully") return m.config.startingStack;
    return m.entrants[userId]!.carryChips ?? m.config.startingStack;
  }

  /**
   * Seats a bracket node's players at a fresh table, blinds back at level 1. Fair Play: equal stacks.
   * Full-on Bullying: everyone brings the chips they won their last table with.
   */
  private openTable(node: BracketNode, now: number) {
    const m = this.meta;
    const t: TableState = {
      id: node.id,
      round: node.round,
      seats: Array.from({ length: m.config.tableSize }, () => null),
      clock: { phase: "level", level: 0, endsAt: now + m.config.levels[0]!.minutes * 60_000 },
      button: -1,
      hand: null,
      handNo: 0,
      actionStartedAt: null,
      handDoneAt: null,
    };
    this.tables.set(t.id, t);
    const seatOrder = this.shuffle(t.seats.map((_, i) => i));
    node.players.forEach((userId, i) => {
      t.seats[seatOrder[i]!] = {
        userId,
        chips: this.stackFor(userId),
        away: false,
        leaving: false,
        timeBankMs: m.config.timeBankSeconds * 1000,
      };
      const e = m.entrants[userId]!;
      e.tableId = t.id;
      e.advancedTo = null;
      e.round = node.round;
      this.hooks.playerMoved(userId, t.id);
    });
    const occupied = t.seats.flatMap((s, i) => (s ? [i] : []));
    t.button = occupied[Math.floor(this.random() * occupied.length)]!;
    this.touchTable(t);
  }

  private finish(now: number, winner: number | null) {
    const m = this.meta;
    if (winner !== null) {
      const e = m.entrants[winner]!;
      e.place = 1;
      e.tableId = null;
      e.advancedTo = null;
      e.points = pointsForPlace(1, this.entrantCount, m.config.payoutPercent);
      this.hooks.playerFinished(winner, 1, e.points);
    }
    m.remaining = 0;
    m.status = "finished";
    m.finishedAt = now;
    this.closeAllTables();
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();
    this.hooks.tournamentFinished();
  }

  // ---------------------------------------------------------------- clock

  /** Each table runs its own blind clock from level 1, with breaks every N levels. */
  private advanceClock(t: TableState, now: number) {
    const { levels, breakEveryLevels, breakMinutes } = this.config;
    const c = t.clock;
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
      this.refillTimeBanks(t);
    }
    if (changed) this.touchTable(t);
  }

  private refillTimeBanks(t: TableState) {
    const { timeBankSeconds, timeBankRefillSeconds } = this.config;
    for (const s of t.seats) if (s) s.timeBankMs = Math.min(timeBankSeconds * 1000, s.timeBankMs + timeBankRefillSeconds * 1000);
  }

  // ---------------------------------------------------------------- helpers

  /** Bracket nodes are stored in id order starting at 1. */
  private node(id: number): BracketNode {
    return this.meta.bracket[id - 1]!;
  }

  locate(userId: number) {
    const e = this.meta.entrants[userId];
    if (!e || e.tableId === null) return null;
    const table = this.tables.get(e.tableId);
    if (!table) return null;
    const seatIdx = table.seats.findIndex((s) => s?.userId === userId);
    if (seatIdx < 0) return null;
    return { table, seat: table.seats[seatIdx]!, seatIdx };
  }

  private nextOccupied(t: TableState, from: number): number {
    const n = t.seats.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + k) % n) + n) % n;
      if (t.seats[i]) return i;
    }
    return -1;
  }

  private closeTable(id: number, winnerId: number | null = null) {
    this.tables.delete(id);
    this.hooks.tableClosed(id, winnerId);
    this.hooks.dirty({ tableId: id, deleted: true });
  }

  private closeAllTables() {
    for (const id of [...this.tables.keys()]) this.closeTable(id);
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

  /** Chips at one table, counting chips committed to the current hand (for tests and sanity checks). */
  chipsAt(t: TableState): number {
    const inHand = new Map(t.hand?.players.map((p) => [p.seat, p]));
    let total = 0;
    t.seats.forEach((s, i) => {
      if (!s) return;
      const p = inHand.get(i);
      total += p ? p.stack + (t.hand!.result ? 0 : p.contributed) : s.chips;
    });
    return total;
  }

  /** The round still being played that started earliest (1 before the start). */
  private currentRound(): number {
    let r = Infinity;
    for (const t of this.tables.values()) r = Math.min(r, t.round);
    return Number.isFinite(r) ? r : Math.max(1, this.meta.totalRounds);
  }

  // ---------------------------------------------------------------- views

  summary(viewerId: number | null): TournamentSummary {
    const m = this.meta;
    const e = viewerId === null ? undefined : m.entrants[viewerId];
    let waiting: NonNullable<TournamentSummary["me"]>["waiting"] = null;
    if (e?.advancedTo != null) {
      const node = this.node(e.advancedTo);
      waiting = {
        round: node.round,
        tableId: node.id,
        groupDone: node.children.filter((c) => this.node(c).done).length,
        groupSize: node.children.length,
      };
    }
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
      chipMode: m.config.chipMode ?? "fair",
      round: m.status === "registering" ? 1 : this.currentRound(),
      totalRounds: m.status === "registering" ? bracketShape(Math.max(2, this.entrantCount), m.config.tableSize).length : m.totalRounds,
      activeTables: this.tables.size,
      registrationOpen: m.status === "registering" && this.entrantCount < m.config.maxPlayers,
      access: this.access,
      firstLevel: m.config.levels[0]!,
      me:
        viewerId === null
          ? null
          : e
            ? { registered: true, pending: false, removed: false, tableId: e.tableId, place: e.place, points: e.points, round: e.round, waiting }
            : { registered: false, pending: Boolean(m.pending?.[viewerId]), removed: Boolean(m.kicked?.includes(viewerId)), tableId: null, place: null, points: 0, round: 0, waiting: null },
    };
  }

  /** Still in contention: asked to join, registered, seated, or waiting for a next table. */
  isStillPlaying(userId: number): boolean {
    const m = this.meta;
    if (m.status !== "registering" && m.status !== "running") return false;
    if (m.pending?.[userId]) return true;
    const e = m.entrants[userId];
    return Boolean(e && e.place === null);
  }

  /** Host view: admins who aren't playing in this tournament see every hand while it runs. */
  canSeeAllCards(viewer: { id: number; isAdmin: boolean }): boolean {
    return viewer.isAdmin && this.meta.status === "running" && !this.isStillPlaying(viewer.id);
  }

  /** What a seated player (their own cards) or a spectator (viewerId null: no hidden cards) sees. */
  tableView(tableId: number, viewerId: number | null, now: number): TableView | null {
    return this.buildView(tableId, viewerId, now, false);
  }

  /** Every hand face up, for an admin who isn't playing. Null for anyone else. */
  hostView(tableId: number, viewer: { id: number; isAdmin: boolean }, now: number): TableView | null {
    if (!this.canSeeAllCards(viewer)) return null;
    return this.buildView(tableId, null, now, true);
  }

  private buildView(tableId: number, viewerId: number | null, now: number, reveal: boolean): TableView | null {
    const t = this.tables.get(tableId);
    if (!t) return null;
    const m = this.meta;
    const { levels } = m.config;
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
        // You keep seeing your own cards after folding; other folded hands stay hidden.
        holeCards: !p ? [] : reveal || s.userId === viewerId ? p.holeCards : p.folded ? [] : shown ? p.holeCards : p.holeCards.map(() => "??"),
        lastAction: lastAction.get(pid) ?? null,
        won: payouts[pid] ?? 0,
        handName: shown?.handName ?? null,
        timeBankMs: s.timeBankMs,
      };
    });

    const c: Clock = t.clock;
    const complete = h?.street === "complete";
    const mySeat = viewerId === null ? -1 : t.seats.findIndex((s) => s?.userId === viewerId);
    return {
      tournamentId: m.id,
      tableId: t.id,
      tableSize: m.config.tableSize,
      seats,
      button: t.button,
      handNo: t.handNo,
      street: h?.street ?? null,
      board: h?.board ?? [],
      rabbit: h && complete ? this.rabbitCards(h) : [],
      myRabbit: h && viewerId !== null && this.config.rabbitHunt !== false ? rabbitResult(h, String(viewerId)) : null,
      pot: h && !complete ? h.players.reduce((n, p) => n + p.contributed - p.bet, 0) : 0,
      currentBet: h?.currentBet ?? 0,
      toActSeat,
      actionStartedAt: t.actionStartedAt,
      decisionMs,
      actionDeadline,
      round: t.round,
      totalRounds: m.totalRounds,
      phase: c.phase,
      levelIndex: c.level,
      level: levels[c.level]!,
      nextLevel: levels[c.level + 1] ?? null,
      phaseEndsAt: m.paused ? null : c.endsAt,
      phaseRemainingMs: m.paused && c.endsAt !== null && m.pausedAt !== null ? c.endsAt - m.pausedAt : null,
      legal: legal && legal.playerId === String(viewerId) && !m.paused ? legal : null,
      mySeat: mySeat < 0 ? null : mySeat,
      handComplete: complete,
      paused: m.paused,
      onBreak: c.phase === "break",
      hostView: reveal,
      serverNow: now,
    };
  }

  detail(viewerId: number | null): TournamentDetail {
    const m = this.meta;
    const entrants = this.entrantCount;
    const chips = new Map<number, number>();
    for (const t of this.tables.values()) for (const s of t.seats) if (s) chips.set(s.userId, s.chips);
    const all = Object.values(m.entrants);
    const alive = all
      .filter((e) => e.place === null && (e.tableId !== null || e.advancedTo !== null))
      .sort((a, b) => b.round - a.round || (chips.get(b.userId) ?? 0) - (chips.get(a.userId) ?? 0));
    const out = all.filter((e) => e.place !== null).sort((a, b) => a.place! - b.place!);
    const points = payoutPoints(entrants, m.config.payoutPercent);
    const nodes = m.bracket;
    return {
      summary: this.summary(viewerId),
      levels: m.config.levels,
      breakEveryLevels: m.config.breakEveryLevels,
      breakMinutes: m.config.breakMinutes,
      payouts: payoutPercents(entrants, m.config.payoutPercent).map((percent, i) => ({ place: i + 1, percent, points: points[i] ?? 0 })),
      rounds: Array.from({ length: m.totalRounds }, (_, i) => {
        const inRound = nodes.filter((n) => n.round === i + 1);
        return {
          round: i + 1,
          tables: inRound.length,
          done: inRound.filter((n) => n.done).length,
          players: i === 0 ? entrants : nodes.filter((n) => n.round === i).length,
        };
      }),
      tables: [...this.tables.values()]
        .sort((a, b) => b.round - a.round || a.id - b.id)
        .map((t) => ({ id: t.id, round: t.round, players: occupiedCount(t), handNo: t.handNo, viewers: this.hooks.viewerCount(t.id) })),
      standings: [...alive, ...out].slice(0, 300).map((e) => ({
        userId: e.userId,
        username: e.username,
        round: e.round,
        chips: chips.get(e.userId) ?? 0,
        place: e.place,
        points: e.points,
        tableId: e.tableId,
      })),
    };
  }
}

