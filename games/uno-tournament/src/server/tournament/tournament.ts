// One Uno bracket tournament.
//
// Players are drawn to round-1 tables of up to `tableSize`. Each table plays hands until someone has
// won `winsToAdvance` of them; that player wins the table and advances, everyone else at the table is
// knocked out. Tables are grouped like a bracket: when every table in a group has a winner, those
// winners meet at a new table with everyone back at zero wins. This repeats until the final table
// produces the champion.
//
// Places: a later round always beats an earlier one. Knockouts at the same table are ranked by hands
// won, then by fewest card points left over from the hands they lost.
//
// Time never comes from Date.now() in here: every method that depends on time takes `now`, and the
// server calls tick(now) a few times a second. That makes pausing, crash recovery and tests simple.
// All state is plain JSON (meta + one object per table) so it can be saved and restored as-is.

import { type Card, COLORS, handPoints, valueOf } from "../../shared/engine/cards.ts";
import { type Action, IllegalActionError, applyAction, autoAction, current, describeEvent, legalActions, removePlayer, startGame, topCard } from "../../shared/engine/game.ts";
import type { ClientAction, SeatView, TableView, TournamentDetail, TournamentSummary } from "../../shared/protocol.ts";
import { bracketShape, evenSplit } from "./structure.ts";
import type { BracketNode, SeatPlayer, TableState, TournamentConfig, TournamentMeta, LobbyAccess } from "./types.ts";

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
  playerFinished(userId: number, place: number): void;
  /** The tournament produced its champion (not called on cancel). */
  tournamentFinished(): void;
  /** Table news for the chat: hand results, UNO catches. */
  tableNews(tableId: number, lines: string[]): void;
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
  tableNews: noop,
  dirty: noop,
};

/** How long a finished hand's result stays on screen before the next hand. */
export const HAND_DONE_MS = 4000;

export interface NewEntrant {
  id: number;
  username: string;
  avatarUrl: string;
}

const occupied = (t: TableState) => t.seats.filter((s): s is SeatPlayer => s !== null);

const COLOR_ORDER = Object.fromEntries(COLORS.map((c, i) => [c, i]));
const VALUE_ORDER = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "S", "R", "D"];
/** Hand order for display: by color, then value, wilds last. */
const cardSortKey = (c: Card) => (c === "W" ? 100 : c === "W4" ? 101 : COLOR_ORDER[c[0]!]! * 20 + VALUE_ORDER.indexOf(valueOf(c)));

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
      entrants: {},
      remaining: 0,
      bracket: [],
      totalRounds: 0,
      roundBlocks: [],
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

  /** Removes a seated player (admin). They take the worst place still open in their round. */
  private removeSeated(userId: number, now: number) {
    const loc = this.locate(userId);
    if (!loc) throw new TournamentError("That player is not seated");
    const { table } = loc;
    if (table.game && !table.game.winner) {
      table.game = removePlayer(table.game, String(userId));
      this.knockOut(table, [userId]);
      this.afterGameChange(table, now, true);
    } else {
      this.knockOut(table, [userId]);
      this.touchTable(table);
    }
    if (!table.game) this.checkTableOver(table, now);
  }

  setAway(userId: number, away: boolean) {
    const loc = this.locate(userId);
    if (!loc) throw new TournamentError("You are not seated");
    loc.seat.away = away;
    this.touchTable(loc.table);
  }

  // ---------------------------------------------------------------- playing

  act(userId: number, action: ClientAction, now: number) {
    const m = this.meta;
    if (m.status !== "running") throw new TournamentError("The tournament is not running");
    if (m.paused) throw new TournamentError("The tournament is paused");
    const loc = this.locate(userId);
    if (!loc) throw new TournamentError("You are not seated");
    const { table, seat } = loc;
    const g = table.game;
    if (!g || g.winner) throw new TournamentError("Wait for the next hand");

    if (action.type === "uno") return this.applyGame(table, userId, { type: "uno" }, now, false);
    if (action.type === "catch") {
      const target = table.seats[action.seat];
      if (!target) throw new TournamentError("Nobody sits there");
      this.applyGame(table, userId, { type: "catch", playerId: String(target.userId) }, now, false);
      this.hooks.tableNews(table.id, [`${this.name(userId)} caught ${this.name(target.userId)} without UNO: +2 cards`]);
      return;
    }

    if (current(g).playerId !== String(userId)) throw new TournamentError("It's not your turn");
    // Time past the normal decision window comes out of the time bank.
    const overflow = Math.max(0, now - (table.actionStartedAt ?? now) - this.config.decisionSeconds * 1000);
    seat.timeBankMs = Math.max(0, seat.timeBankMs - overflow);
    seat.away = false;
    this.applyGame(table, userId, action, now, true);
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

    for (const t of [...this.tables.values()]) this.tickTable(t, now);
    if (m.status !== "running") return; // the final table may have just finished
    for (const t of this.tables.values()) if (!t.game) this.startNextHand(t, now);

    // Keep savedAt fresh so a crash resumes from close to the right moment.
    if (now - m.savedAt > 5000) this.hooks.dirty("meta");
  }

  private tickTable(t: TableState, now: number) {
    if (!t.game) return;
    if (t.game.winner) {
      if (t.handDoneAt !== null && now >= t.handDoneAt) this.finishHand(t, now);
      return;
    }
    const decisionMs = this.config.decisionSeconds * 1000;
    // Players who are away are played for straight away; others when their time runs out.
    for (let guard = 0; guard < 200 && t.game && !t.game.winner; guard++) {
      const pid = Number(current(t.game).playerId);
      const seat = t.seats.find((s) => s?.userId === pid)!;
      if (!seat.away) {
        // Disconnected players get the normal decision time but don't burn their time bank.
        const connected = this.hooks.isConnected(seat.userId);
        const deadline = (t.actionStartedAt ?? now) + decisionMs + (connected ? seat.timeBankMs : 0);
        if (now < deadline) break;
        if (connected) seat.timeBankMs = 0;
        seat.away = true;
      }
      this.applyGame(t, pid, autoAction(t.game), now, true);
    }
  }

  private applyGame(t: TableState, userId: number, action: Action, now: number, resetTimer: boolean) {
    try {
      t.game = applyAction(t.game!, String(userId), action);
    } catch (err) {
      if (err instanceof IllegalActionError) throw new TournamentError(err.message);
      throw err;
    }
    this.afterGameChange(t, now, resetTimer);
  }

  private afterGameChange(t: TableState, now: number, resetTimer: boolean) {
    const g = t.game!;
    if (g.winner) {
      const winner = Number(g.winner);
      const points: Record<string, number> = {};
      for (const p of g.players) if (p.playerId !== g.winner) points[p.playerId] = handPoints(p.hand);
      t.lastResult = { winner, points };
      t.actionStartedAt = null;
      t.handDoneAt = now + HAND_DONE_MS;
      const seat = t.seats.find((s) => s?.userId === winner);
      const wins = (seat?.wins ?? 0) + 1;
      this.hooks.tableNews(t.id, [`Hand #${t.handNo}: ${this.name(winner)} wins (${wins}/${this.config.winsToAdvance})`]);
    } else if (resetTimer) {
      t.actionStartedAt = now;
    }
    this.touchTable(t);
  }

  private startNextHand(t: TableState, now: number) {
    const seated = t.seats.flatMap((s, i) => (s ? [{ playerId: String(s.userId), seat: i }] : []));
    if (seated.length < 2) return;
    t.dealer = this.nextOccupied(t, t.dealer);
    t.game = startGame({
      players: seated,
      dealer: seated.findIndex((p) => p.seat === t.dealer),
      stacking: this.config.stacking,
      seed: Math.floor(this.random() * 2 ** 31),
    });
    t.handNo++;
    t.lastResult = null;
    this.afterGameChange(t, now, true);
  }

  /** Scores the hand that just ended, then either deals again or ends the table. */
  private finishHand(t: TableState, now: number) {
    const result = t.lastResult;
    t.game = null;
    t.handDoneAt = null;
    t.actionStartedAt = null;
    if (result) {
      for (const s of occupied(t)) {
        if (s.userId === result.winner) s.wins++;
        else s.points += result.points[s.userId] ?? 0;
      }
    }
    this.touchTable(t);
    this.checkTableOver(t, now);
  }

  /** Removes players from their seats and gives them finishing places, worst first. */
  private knockOut(t: TableState, worstFirst: number[]) {
    if (!worstFirst.length) return;
    const m = this.meta;
    const block = m.roundBlocks[t.round - 1]!;
    for (const userId of worstFirst) {
      const i = t.seats.findIndex((s) => s?.userId === userId);
      if (i < 0) continue;
      t.seats[i] = null;
      const e = m.entrants[userId]!;
      e.tableId = null;
      e.place = Math.max(1, block.worst - block.eliminated++);
      m.remaining--;
      this.hooks.playerFinished(e.userId, e.place);
    }
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();
  }

  // ---------------------------------------------------------------- bracket

  /** A table is over when someone has enough hand wins, or one player (or nobody) is left. */
  private checkTableOver(t: TableState, now: number) {
    if (t.game) return;
    const left = occupied(t);
    const champ = left.length <= 1 ? left[0] : left.find((s) => s.wins >= this.config.winsToAdvance);
    if (left.length > 1 && !champ) return;
    // Everyone else is out: fewest wins first, then most leftover card points.
    const losers = left.filter((s) => s !== champ).sort((a, b) => a.wins - b.wins || b.points - a.points);
    this.knockOut(t, losers.map((s) => s.userId));
    this.closeTable(t.id, champ?.userId ?? null);
    this.completeNode(this.node(t.id), champ?.userId ?? null, now);
  }

  /** Records a table's winner and moves them up the bracket. */
  private completeNode(node: BracketNode, winner: number | null, now: number) {
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
      parent.players.push(winner);
      this.hooks.playerAdvanced(winner, parent.round);
    }
    if (!parent.children.every((c) => this.node(c).done)) return;

    // Whole group done. Normally that's a new table; if only one winner came through, they advance again.
    if (parent.players.length >= 2) this.openTable(parent, now);
    else this.completeNode(parent, parent.players[0] ?? null, now);
  }

  /** Seats a bracket node's players at a fresh table, everyone on zero wins. */
  private openTable(node: BracketNode, now: number) {
    const m = this.meta;
    const t: TableState = {
      id: node.id,
      round: node.round,
      seats: Array.from({ length: m.config.tableSize }, () => null),
      dealer: -1,
      game: null,
      handNo: 0,
      actionStartedAt: null,
      handDoneAt: null,
      lastResult: null,
    };
    this.tables.set(t.id, t);
    // Spread players around the table rather than bunching them in the first seats.
    const seatOrder = this.spreadSeats(node.players.length, t.seats.length);
    node.players.forEach((userId, i) => {
      t.seats[seatOrder[i]!] = { userId, wins: 0, points: 0, away: false, timeBankMs: m.config.timeBankSeconds * 1000 };
      const e = m.entrants[userId]!;
      e.tableId = t.id;
      e.advancedTo = null;
      e.round = node.round;
      this.hooks.playerMoved(userId, t.id);
    });
    const taken = t.seats.flatMap((s, i) => (s ? [i] : []));
    // The first hand's dealer is random; startNextHand moves the deal on one seat before dealing.
    t.dealer = taken[Math.floor(this.random() * taken.length)]!;
    this.touchTable(t);
  }

  private spreadSeats(players: number, seats: number): number[] {
    const order = Array.from({ length: players }, (_, i) => Math.floor((i * seats) / players));
    return this.shuffle(order);
  }

  private finish(now: number, winner: number | null) {
    const m = this.meta;
    if (winner !== null) {
      const e = m.entrants[winner]!;
      e.place = 1;
      e.tableId = null;
      e.advancedTo = null;
      this.hooks.playerFinished(winner, 1);
    }
    m.remaining = 0;
    m.status = "finished";
    m.finishedAt = now;
    this.closeAllTables();
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();
    this.hooks.tournamentFinished();
  }

  // ---------------------------------------------------------------- helpers

  /** Bracket nodes are stored in id order starting at 1. */
  private node(id: number): BracketNode {
    return this.meta.bracket[id - 1]!;
  }

  private name(userId: number) {
    return this.meta.entrants[userId]?.username ?? "Someone";
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
      tableSize: m.config.tableSize,
      winsToAdvance: m.config.winsToAdvance,
      stacking: m.config.stacking,
      round: m.status === "registering" ? 1 : this.currentRound(),
      totalRounds: m.status === "registering" ? bracketShape(Math.max(2, this.entrantCount), m.config.tableSize).length : m.totalRounds,
      activeTables: this.tables.size,
      registrationOpen: m.status === "registering" && this.entrantCount < m.config.maxPlayers,
      access: this.access,
      me:
        viewerId === null
          ? null
          : e
            ? { registered: true, pending: false, removed: false, tableId: e.tableId, place: e.place, round: e.round, waiting }
            : { registered: false, pending: Boolean(m.pending?.[viewerId]), removed: Boolean(m.kicked?.includes(viewerId)), tableId: null, place: null, round: 0, waiting: null },
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

  /** What one viewer may see of a table: their own cards only, everyone else's as counts. */
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
    const g = t.game;
    const decisionMs = m.config.decisionSeconds * 1000;
    const inGame = new Map(g?.players.map((p) => [p.seat, p]));
    const done = Boolean(g?.winner);

    const toActSeat = g && !g.winner ? current(g).seat : null;
    let actionDeadline: number | null = null;
    if (toActSeat !== null && t.actionStartedAt !== null) {
      const s = t.seats[toActSeat]!;
      actionDeadline = t.actionStartedAt + decisionMs + (this.hooks.isConnected(s.userId) ? s.timeBankMs : 0);
    }

    const seats = t.seats.map((s, i): SeatView | null => {
      if (!s) return null;
      const e = m.entrants[s.userId]!;
      const p = inGame.get(i);
      const pid = String(s.userId);
      return {
        seat: i,
        userId: s.userId,
        username: e.username,
        avatarUrl: e.avatarUrl,
        cardCount: p?.hand.length ?? 0,
        wins: s.wins,
        points: s.points,
        away: s.away,
        connected: this.hooks.isConnected(s.userId),
        calledUno: p?.calledUno ?? false,
        catchable: Boolean(g && !g.winner && g.unoVulnerable === pid),
        handPoints: done && t.lastResult ? (t.lastResult.points[pid] ?? null) : null,
        timeBankMs: s.timeBankMs,
        ...(reveal && p ? { hand: [...p.hand].sort((a, b) => cardSortKey(a) - cardSortKey(b)) } : {}),
      };
    });

    const mySeat = viewerId === null ? -1 : t.seats.findIndex((s) => s?.userId === viewerId);
    const me = mySeat >= 0 ? inGame.get(mySeat) : undefined;
    const legal = g && me && !m.paused ? legalActions(g) : null;
    return {
      tournamentId: m.id,
      tableId: t.id,
      tableSize: m.config.tableSize,
      seats,
      dealer: t.dealer,
      handNo: t.handNo,
      topCard: g ? topCard(g) : null,
      color: g?.color ?? null,
      direction: g?.direction ?? 1,
      drawPileCount: g?.drawPile.length ?? 0,
      pendingDraw: g?.pendingDraw ?? 0,
      toActSeat,
      actionStartedAt: t.actionStartedAt,
      decisionMs,
      actionDeadline,
      round: t.round,
      totalRounds: m.totalRounds,
      winsToAdvance: m.config.winsToAdvance,
      stacking: m.config.stacking,
      myHand: me ? [...me.hand].sort((a, b) => cardSortKey(a) - cardSortKey(b)) : [],
      legal: legal && legal.playerId === String(viewerId) ? legal : null,
      canCallUno: Boolean(me && !done && !m.paused && me.hand.length <= 2 && !me.calledUno),
      mySeat: mySeat < 0 ? null : mySeat,
      events: (g?.log ?? []).slice(-6).map((ev) => describeEvent(ev, (pid) => this.name(Number(pid)))),
      handWinnerSeat: done ? (g!.players.find((p) => p.playerId === g!.winner)?.seat ?? null) : null,
      handComplete: done,
      paused: m.paused,
      hostView: reveal,
      serverNow: now,
    };
  }

  detail(viewerId: number | null): TournamentDetail {
    const m = this.meta;
    const entrants = this.entrantCount;
    const wins = new Map<number, number>();
    for (const t of this.tables.values()) for (const s of t.seats) if (s) wins.set(s.userId, s.wins);
    const all = Object.values(m.entrants);
    const alive = all
      .filter((e) => e.place === null && (e.tableId !== null || e.advancedTo !== null))
      .sort((a, b) => b.round - a.round || (wins.get(b.userId) ?? 0) - (wins.get(a.userId) ?? 0));
    const out = all.filter((e) => e.place !== null).sort((a, b) => a.place! - b.place!);
    const nodes = m.bracket;
    return {
      summary: this.summary(viewerId),
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
        .map((t) => {
          const lead = occupied(t).sort((a, b) => b.wins - a.wins)[0];
          return {
            id: t.id,
            round: t.round,
            players: occupied(t).length,
            handNo: t.handNo,
            leader: lead && lead.wins > 0 ? this.name(lead.userId) : null,
            leaderWins: lead?.wins ?? 0,
            viewers: this.hooks.viewerCount(t.id),
          };
        }),
      standings: [...alive, ...out].slice(0, 300).map((e) => ({
        userId: e.userId,
        username: e.username,
        round: e.round,
        wins: wins.get(e.userId) ?? 0,
        place: e.place,
        tableId: e.tableId,
      })),
    };
  }
}
