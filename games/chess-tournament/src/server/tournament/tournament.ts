// One chess knockout tournament, using the same bracket system as Uno Night with two players per
// board.
//
// Players are drawn into a bracket sized to the next power of two; anyone without a round-1
// opponent gets a bye. Each board plays a match: games until someone has won `winsToAdvance` of
// them. Colors alternate every game. Draws don't count, and after two draws in a row the next game is
// Armageddon (a draw counts as a win for Black), so every match ends. The match winner advances to
// meet the winner of the neighbouring board, until the final produces the champion.
//
// Places: a later round always beats an earlier one. Within a round, players knocked out later
// rank higher.
//
// Time never comes from Date.now() in here: every method that depends on time takes `now`, and the
// server calls tick(now) a few times a second. That makes pausing, crash recovery and tests simple.
// All state is plain JSON (meta + one object per board) so it can be saved and restored as-is.

import { type Color, IllegalMoveError, applyMove, canMate, inCheck, legalUci, newGame, parseUci } from "../../shared/engine/chess.ts";
import type { ClientAction, SeatView, TableView, TournamentDetail, TournamentSummary } from "../../shared/protocol.ts";
import { DRAWS_BEFORE_ARMAGEDDON, FIRST_MOVE_MS, bracketShape, spreadOrder } from "./structure.ts";
import type { BracketNode, GameEndReason, MatchGame, SeatPlayer, TableState, TournamentConfig, TournamentMeta, LobbyAccess } from "./types.ts";

export class TournamentError extends Error {}

export interface TournamentHooks {
  isConnected(userId: number): boolean;
  tableChanged(tableId: number): void;
  tableClosed(tableId: number): void;
  lobbyChanged(): void;
  playerMoved(userId: number, tableId: number): void;
  playerAdvanced(userId: number, round: number, bye: boolean): void;
  playerFinished(userId: number, place: number): void;
  /** The tournament produced its champion (not called on cancel). */
  tournamentFinished(): void;
  /** Board news for the chat: game results, draw offers. */
  tableNews(tableId: number, lines: string[]): void;
  /** Something needs saving: the meta row, or a board row (deleted = remove it). */
  dirty(what: "meta" | { tableId: number; deleted?: boolean }): void;
}

const noop = () => {};
export const noopHooks: TournamentHooks = {
  isConnected: () => true,
  tableChanged: noop,
  tableClosed: noop,
  lobbyChanged: noop,
  playerMoved: noop,
  playerAdvanced: noop,
  playerFinished: noop,
  tournamentFinished: noop,
  tableNews: noop,
  dirty: noop,
};

/** How long a finished game's result stays on screen before the next game. */
export const GAME_DONE_MS = 6000;

export interface NewEntrant {
  id: number;
  username: string;
  avatarUrl: string;
}

const occupied = (t: TableState) => t.seats.filter((s): s is SeatPlayer => s !== null);
const other = (c: Color): Color => (c === "w" ? "b" : "w");

const REASON_TEXT: Record<GameEndReason, string> = {
  checkmate: "checkmate",
  stalemate: "stalemate",
  repetition: "threefold repetition",
  "fifty-move": "fifty-move rule",
  insufficient: "insufficient material",
  resign: "resignation",
  timeout: "time",
  "timeout-draw": "time out, but no mating material",
  agreement: "agreement",
  "no-move": "no first move",
  removed: "player removed",
};

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
    if (e && e.place !== null) throw new TournamentError("That player is already out");
    if (!(m.kicked ??= []).includes(userId)) m.kicked.push(userId);
    if (asked) delete m.pending![userId];
    if (e && m.status === "registering") delete m.entrants[userId];
    else if (e && this.locate(userId)) this.removeSeated(userId, now);
    this.hooks.dirty("meta");
    this.hooks.lobbyChanged();
  }

  // ---------------------------------------------------------------- lifecycle

  /** Draws the bracket, seats round 1 and sends players with a bye through. */
  start(now: number) {
    const m = this.meta;
    if (m.status !== "registering") throw new TournamentError("The tournament has already started");
    const ids = this.shuffle(Object.keys(m.entrants).map(Number));
    if (ids.length < 2) throw new TournamentError("At least two players must be registered to start");

    // Build the bracket: round 1 matches first, then each later match is fed by two of the round before.
    const shape = bracketShape(ids.length);
    const bracket: BracketNode[] = [];
    let prev: BracketNode[] = [];
    shape.forEach((count, r) => {
      const round: BracketNode[] = [];
      for (let i = 0; i < count; i++) {
        const node: BracketNode = { id: bracket.length + 1, round: r + 1, parent: null, children: [], players: [], done: false, winner: null };
        bracket.push(node);
        round.push(node);
        for (const child of prev.slice(i * 2, i * 2 + 2)) {
          child.parent = node.id;
          node.children.push(child.id);
        }
      }
      prev = round;
    });
    // One player per round-1 match, then the rest as opponents, spread so the byes are too.
    const firstRound = bracket.filter((n) => n.round === 1);
    ids.slice(0, firstRound.length).forEach((userId, i) => firstRound[i]!.players.push(userId));
    const order = spreadOrder(firstRound.length);
    ids.slice(firstRound.length).forEach((userId, i) => firstRound[order[i]!]!.players.push(userId));

    // Each round's knockouts take a block of finishing places, worst first.
    m.roundBlocks = [];
    let worst = ids.length;
    shape.forEach((matches, r) => {
      m.roundBlocks.push({ worst, eliminated: 0 });
      const playersInRound = r === 0 ? ids.length : shape[r - 1]!;
      worst -= playersInRound - matches;
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
    for (const node of firstRound) if (node.players.length === 2) this.openTable(node);
    for (const node of firstRound) if (node.players.length === 1) this.completeNode(node, node.players[0]!, now, true);
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

  /** Continues every clock from exactly where it was when the pause began. */
  resume(now: number) {
    const m = this.meta;
    if (!m.paused || m.pausedAt === null) throw new TournamentError("The tournament is not paused");
    const shift = now - m.pausedAt;
    for (const t of this.tables.values()) {
      if (t.game && !t.game.result) t.game.turnStartedAt += shift;
      if (t.gameDoneAt !== null) t.gameDoneAt += shift;
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

  /** Removes a seated player (admin). Their opponent wins the match. */
  private removeSeated(userId: number, now: number) {
    const loc = this.locate(userId);
    if (!loc) throw new TournamentError("That player is not seated");
    const { table } = loc;
    table.game = null;
    table.gameDoneAt = null;
    this.hooks.tableNews(table.id, [`${this.name(userId)} was removed from the tournament`]);
    this.knockOut(table, [userId]);
    this.touchTable(table);
    this.checkTableOver(table, now);
  }

  // ---------------------------------------------------------------- playing

  act(userId: number, action: ClientAction, now: number) {
    const m = this.meta;
    if (m.status !== "running") throw new TournamentError("The tournament is not running");
    if (m.paused) throw new TournamentError("The tournament is paused");
    const loc = this.locate(userId);
    if (!loc) throw new TournamentError("You are not seated");
    const { table } = loc;
    const g = table.game;
    if (!g || g.result) throw new TournamentError("Wait for the next game");
    const opponent = g.white === userId ? g.black : g.white;

    switch (action.type) {
      case "move":
        return this.move(table, g, userId, action.uci, now);
      case "resign":
        return this.endGame(table, opponent, "resign", now);
      case "draw":
        if (g.drawOffer === opponent) return this.endGame(table, null, "agreement", now);
        if (g.drawOffer === userId) throw new TournamentError("You've already offered a draw");
        g.drawOffer = userId;
        this.hooks.tableNews(table.id, [`${this.name(userId)} offers a draw`]);
        return this.touchTable(table);
      case "declineDraw":
        if (g.drawOffer !== opponent) throw new TournamentError("There's no draw offer to decline");
        g.drawOffer = null;
        this.hooks.tableNews(table.id, [`${this.name(userId)} declines the draw`]);
        return this.touchTable(table);
    }
  }

  private move(t: TableState, g: MatchGame, userId: number, uci: string, now: number) {
    const color: Color = g.white === userId ? "w" : "b";
    if (g.chess.turn !== color) throw new TournamentError("It's not your turn");
    if (this.checkFlag(t, g, now)) throw new TournamentError("Your time ran out");
    const clocksRun = g.chess.uci.length >= 2;
    try {
      g.chess = applyMove(g.chess, uci);
    } catch (err) {
      if (err instanceof IllegalMoveError) throw new TournamentError(err.message);
      throw err;
    }
    // Clocks start after both sides' first move; from then on each move adds the increment.
    if (clocksRun) g.clocks[color] = g.clocks[color] - (now - g.turnStartedAt) + this.config.incrementSeconds * 1000;
    g.turnStartedAt = now;
    // Moving answers the opponent's draw offer with a no.
    if (g.drawOffer !== null && g.drawOffer !== userId) g.drawOffer = null;
    const end = g.chess.end;
    if (end) this.endGame(t, end.winner === null ? null : end.winner === "w" ? g.white : g.black, end.reason, now);
    else this.touchTable(t);
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
    if (m.status !== "running") return; // the final may have just finished
    for (const t of this.tables.values()) if (!t.game) this.startNextGame(t, now);

    // Keep savedAt fresh so a crash resumes from close to the right moment.
    if (now - m.savedAt > 5000) this.hooks.dirty("meta");
  }

  private tickTable(t: TableState, now: number) {
    const g = t.game;
    if (!g) return;
    if (g.result) {
      if (t.gameDoneAt !== null && now >= t.gameDoneAt) this.finishGame(t, now);
      return;
    }
    this.checkFlag(t, g, now);
  }

  /** Ends the game if the side to move is out of time (or missed their first move). */
  private checkFlag(t: TableState, g: MatchGame, now: number): boolean {
    const mover = g.chess.turn;
    const elapsed = now - g.turnStartedAt;
    const firstMove = g.chess.uci.length < 2;
    if (firstMove ? elapsed < FIRST_MOVE_MS : elapsed < g.clocks[mover]) return false;
    const opponentColor = other(mover);
    const opponent = opponentColor === "w" ? g.white : g.black;
    if (firstMove) this.endGame(t, opponent, "no-move", now);
    // Losing on time is only a loss if the opponent could still mate.
    else if (canMate(g.chess.board, opponentColor)) this.endGame(t, opponent, "timeout", now);
    else this.endGame(t, null, "timeout-draw", now);
    return true;
  }

  private endGame(t: TableState, winner: number | null, reason: GameEndReason, now: number) {
    const g = t.game!;
    // Freeze the mover's clock where it stopped.
    if (g.chess.uci.length >= 2) {
      const mover = g.chess.turn;
      g.clocks[mover] = Math.max(0, g.clocks[mover] - (now - g.turnStartedAt));
    }
    let armageddonWin = false;
    if (winner === null && g.armageddon) {
      winner = g.black;
      armageddonWin = true;
    }
    g.result = armageddonWin ? { winner, reason, armageddon: true } : { winner, reason };
    g.drawOffer = null;
    t.gameDoneAt = now + GAME_DONE_MS;
    const seat = winner === null ? null : t.seats.find((s) => s?.userId === winner);
    const wins = (seat?.wins ?? 0) + 1;
    const how = REASON_TEXT[reason];
    this.hooks.tableNews(t.id, [
      winner === null
        ? `Game ${t.gameNo}: draw by ${how}. Draws don't count; the match goes on.`
        : armageddonWin
          ? `Game ${t.gameNo}: draw by ${how}, so Black (${this.name(winner)}) wins the Armageddon game`
          : `Game ${t.gameNo}: ${this.name(winner)} wins by ${how} (${wins}/${this.config.winsToAdvance})`,
    ]);
    this.touchTable(t);
  }

  private startNextGame(t: TableState, now: number) {
    const left = occupied(t);
    if (left.length < 2) return;
    const [a, b] = left as [SeatPlayer, SeatPlayer];
    // Colors are random in game 1, then alternate.
    const white = t.lastWhite === null ? (this.random() < 0.5 ? a.userId : b.userId) : t.lastWhite === a.userId ? b.userId : a.userId;
    const black = white === a.userId ? b.userId : a.userId;
    const clock = this.config.minutes * 60_000;
    t.game = {
      chess: newGame(),
      white,
      black,
      clocks: { w: clock, b: clock },
      turnStartedAt: now,
      armageddon: t.drawStreak >= DRAWS_BEFORE_ARMAGEDDON,
      drawOffer: null,
      result: null,
    };
    t.gameNo++;
    this.hooks.tableNews(t.id, [
      `Game ${t.gameNo}: ${this.name(white)} has White, ${this.name(black)} has Black` +
        (t.game.armageddon ? ". Armageddon: a draw counts as a win for Black." : ""),
    ]);
    this.touchTable(t);
  }

  /** Scores the game that just ended, then either starts the next one or ends the match. */
  private finishGame(t: TableState, now: number) {
    const g = t.game!;
    const winner = g.result?.winner ?? null;
    for (const s of occupied(t)) {
      if (winner === null) s.draws++;
      else if (s.userId === winner) s.wins++;
    }
    t.drawStreak = winner === null ? t.drawStreak + 1 : 0;
    t.lastWhite = g.white;
    t.game = null;
    t.gameDoneAt = null;
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

  /** A match is over when someone has enough game wins, or one player (or nobody) is left. */
  private checkTableOver(t: TableState, now: number) {
    if (t.game) return;
    const left = occupied(t);
    const champ = left.length <= 1 ? left[0] : left.find((s) => s.wins >= this.config.winsToAdvance);
    if (left.length > 1 && !champ) return;
    if (champ && left.length > 1) this.hooks.tableNews(t.id, [`${this.name(champ.userId)} wins the match ${champ.wins}–${left.find((s) => s !== champ)!.wins}`]);
    this.knockOut(t, left.filter((s) => s !== champ).map((s) => s.userId));
    this.closeTable(t.id);
    this.completeNode(this.node(t.id), champ?.userId ?? null, now);
  }

  /** Records a match's winner and moves them up the bracket. */
  private completeNode(node: BracketNode, winner: number | null, now: number, bye = false) {
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
      this.hooks.playerAdvanced(winner, parent.round, bye);
    }
    if (!parent.children.every((c) => this.node(c).done)) return;

    // Both feeder matches done. Normally that's a new match; if only one winner came through, they advance again.
    if (parent.players.length >= 2) this.openTable(parent);
    else this.completeNode(parent, parent.players[0] ?? null, now, true);
  }

  /** Seats a bracket node's two players at a fresh board, both on zero wins. */
  private openTable(node: BracketNode) {
    const t: TableState = {
      id: node.id,
      round: node.round,
      seats: [null, null],
      game: null,
      gameNo: 0,
      lastWhite: null,
      drawStreak: 0,
      gameDoneAt: null,
    };
    this.tables.set(t.id, t);
    node.players.forEach((userId, i) => {
      t.seats[i] = { userId, wins: 0, draws: 0 };
      const e = this.meta.entrants[userId]!;
      e.tableId = t.id;
      e.advancedTo = null;
      e.round = node.round;
      this.hooks.playerMoved(userId, t.id);
    });
    this.touchTable(t);
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

  private closeTable(id: number) {
    this.tables.delete(id);
    this.hooks.tableClosed(id);
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
      winsToAdvance: m.config.winsToAdvance,
      minutes: m.config.minutes,
      incrementSeconds: m.config.incrementSeconds,
      round: m.status === "registering" ? 1 : this.currentRound(),
      totalRounds: m.status === "registering" ? bracketShape(Math.max(2, this.entrantCount)).length : m.totalRounds,
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

  /** Everything about a board. Chess has no hidden information; only the legal moves are personal. */
  tableView(tableId: number, viewerId: number | null, now: number): TableView | null {
    const t = this.tables.get(tableId);
    if (!t) return null;
    const m = this.meta;
    const g = t.game;
    const colorOfUser = (userId: number): Color | null => (g ? (g.white === userId ? "w" : g.black === userId ? "b" : null) : t.lastWhite === null ? null : t.lastWhite === userId ? "w" : "b");

    const seats = t.seats.map((s, i): SeatView | null => {
      if (!s) return null;
      const e = m.entrants[s.userId]!;
      return {
        seat: i,
        userId: s.userId,
        username: e.username,
        avatarUrl: e.avatarUrl,
        color: colorOfUser(s.userId),
        wins: s.wins,
        draws: s.draws,
        connected: this.hooks.isConnected(s.userId),
      };
    });
    const seatOf = (userId: number | null) => (userId === null ? null : t.seats.findIndex((s) => s?.userId === userId));

    const mySeatIdx = viewerId === null ? -1 : t.seats.findIndex((s) => s?.userId === viewerId);
    const myColor = mySeatIdx >= 0 ? colorOfUser(viewerId!) : null;
    const live = Boolean(g && !g.result);
    const firstMove = Boolean(g && g.chess.uci.length < 2);
    const lastUci = g?.chess.uci.at(-1);
    const last = lastUci ? parseUci(lastUci) : null;
    const clock = m.config.minutes * 60_000;
    return {
      tournamentId: m.id,
      tableId: t.id,
      seats,
      gameNo: t.gameNo,
      board: g?.chess.board ?? [],
      turn: g?.chess.turn ?? "w",
      moves: g?.chess.san ?? [],
      lastMove: last ? { from: last.from, to: last.to } : null,
      checkSquare: g && inCheck(g.chess) ? g.chess.board.indexOf(g.chess.turn === "w" ? "K" : "k") : null,
      clocks: g?.clocks ?? { w: clock, b: clock },
      turnStartedAt: live && !firstMove ? g!.turnStartedAt : null,
      firstMoveDeadline: live && firstMove ? g!.turnStartedAt + FIRST_MOVE_MS : null,
      minutes: m.config.minutes,
      incrementSeconds: m.config.incrementSeconds,
      armageddon: g?.armageddon ?? false,
      drawOfferSeat: g?.drawOffer != null ? seatOf(g.drawOffer) : null,
      result: g?.result ? { winnerSeat: seatOf(g.result.winner), reason: REASON_TEXT[g.result.reason], armageddon: Boolean(g.result.armageddon) } : null,
      round: t.round,
      totalRounds: m.totalRounds,
      winsToAdvance: m.config.winsToAdvance,
      mySeat: mySeatIdx < 0 ? null : mySeatIdx,
      myColor,
      legal: live && !m.paused && myColor !== null && g!.chess.turn === myColor ? legalUci(g!.chess) : [],
      paused: m.paused,
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
          players: i === 0 ? entrants : inRound.length * 2,
        };
      }),
      tables: [...this.tables.values()]
        .sort((a, b) => b.round - a.round || a.id - b.id)
        .map((t) => {
          const seated = occupied(t);
          return {
            id: t.id,
            round: t.round,
            players: seated.map((s) => this.name(s.userId)),
            score: seated.map((s) => s.wins).join("–"),
            gameNo: t.gameNo,
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
