// No-Limit Hold'em hand engine.
//
// Everything here is pure: functions take a HandState and return a new one, and the state is plain
// JSON, so the server can save it after every action and resume after a restart. The deck is passed
// in, which keeps tests deterministic; the server supplies a crypto-shuffled deck (see cards.ts).

import type { Card } from "./cards.ts";
import { evaluate } from "./evaluator.ts";

export type Street = "preflop" | "flop" | "turn" | "river" | "complete";

export type Action =
  | { type: "fold" }
  | { type: "check" }
  | { type: "call" }
  /** Bet or raise so the player's total bet this street becomes `to`. */
  | { type: "raise"; to: number };

export interface SeatInput {
  playerId: string;
  stack: number;
}

export interface HandConfig {
  /** Index = seat number at the table; null = empty seat. */
  seats: (SeatInput | null)[];
  /** Seat number of the dealer button. Must be occupied. */
  button: number;
  smallBlind: number;
  bigBlind: number;
  /** Per-player ante, posted dead before the blinds. 0 for none. */
  ante: number;
}

export interface PlayerState {
  seat: number;
  playerId: string;
  /** Chips still behind (not yet committed). */
  stack: number;
  /** Chips committed on the current street. */
  bet: number;
  /** Chips committed this hand, including antes. Used to build side pots. */
  contributed: number;
  holeCards: Card[];
  folded: boolean;
  allIn: boolean;
  /** actionSeq of this player's last voluntary action this street, or -1. */
  lastActionSeq: number;
}

export type HandEvent =
  | { type: "ante" | "smallBlind" | "bigBlind"; playerId: string; amount: number }
  | { type: "action"; playerId: string; action: Action; amount: number; allIn: boolean }
  | { type: "street"; street: Street; board: Card[] };

export interface PotResult {
  amount: number;
  eligible: string[];
  winners: { playerId: string; amount: number }[];
}

export interface HandResult {
  pots: PotResult[];
  /** Hands revealed at showdown. Empty when everyone else folded. */
  showdown: { playerId: string; holeCards: Card[]; handName: string; best: Card[] }[];
  /** Total chips won per player (gross, not net of what they put in). */
  payouts: Record<string, number>;
}

export interface HandState {
  smallBlind: number;
  bigBlind: number;
  ante: number;
  /** Occupied seats in seat order. Turn order is by index into this array. */
  players: PlayerState[];
  buttonIdx: number;
  deck: Card[];
  deckPos: number;
  board: Card[];
  street: Street;
  /** Highest bet on this street. */
  currentBet: number;
  /** Size of the last full raise on this street; the next raise must be at least this much more. */
  minRaise: number;
  actionSeq: number;
  /** actionSeq of the last full raise. Players who acted after it (a short all-in since) may not re-raise. */
  lastFullRaiseSeq: number;
  /** Index into players of whoever must act, or null when the hand is complete. */
  toAct: number | null;
  log: HandEvent[];
  result: HandResult | null;
}

export interface LegalActions {
  playerId: string;
  canFold: boolean;
  canCheck: boolean;
  /** Chips needed to call (capped at the player's stack). 0 when checking is possible. */
  callAmount: number;
  canRaise: boolean;
  /** Smallest legal `to` for a raise (equals maxRaiseTo when only an all-in is possible). */
  minRaiseTo: number;
  /** All-in amount. */
  maxRaiseTo: number;
}

export class IllegalActionError extends Error {}

const canAct = (p: PlayerState) => !p.folded && !p.allIn;

function nextIdx(state: HandState, from: number, pred: (p: PlayerState) => boolean): number {
  const n = state.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (pred(state.players[i]!)) return i;
  }
  return -1;
}

function commit(p: PlayerState, amount: number): number {
  const amt = Math.min(amount, p.stack);
  p.stack -= amt;
  p.bet += amt;
  p.contributed += amt;
  if (p.stack === 0) p.allIn = true;
  return amt;
}

function draw(state: HandState): Card {
  const card = state.deck[state.deckPos++];
  if (!card) throw new Error("Deck exhausted");
  return card;
}

export function startHand(config: HandConfig, deck: Card[]): HandState {
  const players: PlayerState[] = [];
  config.seats.forEach((s, seat) => {
    if (s && s.stack > 0)
      players.push({
        seat,
        playerId: s.playerId,
        stack: s.stack,
        bet: 0,
        contributed: 0,
        holeCards: [],
        folded: false,
        allIn: false,
        lastActionSeq: -1,
      });
  });
  if (players.length < 2) throw new Error("A hand needs at least two players with chips");
  const buttonIdx = players.findIndex((p) => p.seat === config.button);
  if (buttonIdx < 0) throw new Error("Button must be on an occupied seat");

  const state: HandState = {
    smallBlind: config.smallBlind,
    bigBlind: config.bigBlind,
    ante: config.ante,
    players,
    buttonIdx,
    deck: [...deck],
    deckPos: 0,
    board: [],
    street: "preflop",
    currentBet: 0,
    minRaise: config.bigBlind,
    actionSeq: 0,
    lastFullRaiseSeq: 0,
    toAct: null,
    log: [],
    result: null,
  };

  if (config.ante > 0) {
    for (const p of players) {
      const amt = Math.min(config.ante, p.stack);
      p.stack -= amt;
      p.contributed += amt;
      if (p.stack === 0) p.allIn = true;
      state.log.push({ type: "ante", playerId: p.playerId, amount: amt });
    }
  }

  // Heads-up, the button posts the small blind and acts first preflop.
  const n = players.length;
  const sbIdx = n === 2 ? buttonIdx : (buttonIdx + 1) % n;
  const bbIdx = (sbIdx + 1) % n;
  const sb = players[sbIdx]!;
  const bb = players[bbIdx]!;
  if (!sb.allIn) state.log.push({ type: "smallBlind", playerId: sb.playerId, amount: commit(sb, config.smallBlind) });
  if (!bb.allIn) state.log.push({ type: "bigBlind", playerId: bb.playerId, amount: commit(bb, config.bigBlind) });
  // Others must call the full big blind even if the big blind was short.
  state.currentBet = config.bigBlind;

  for (let round = 0; round < 2; round++)
    for (let k = 1; k <= n; k++) players[(buttonIdx + k) % n]!.holeCards.push(draw(state));

  state.toAct = bbIdx; // advance() moves to the first player who needs to act after the big blind
  return advance(state);
}

function roundComplete(state: HandState): boolean {
  const actors = state.players.filter(canAct);
  if (actors.length === 0) return true;
  if (actors.length === 1) {
    // Everyone else is all-in or folded: no more betting is possible, and the last player only owes
    // a decision if a live opponent has put in more than they have.
    const p = actors[0]!;
    return state.players.every((o) => o === p || o.folded || o.bet <= p.bet);
  }
  return actors.every((p) => p.lastActionSeq >= 0 && p.bet === state.currentBet);
}

const needsToAct = (state: HandState) => (p: PlayerState) =>
  canAct(p) && (p.lastActionSeq < 0 || p.bet < state.currentBet);

function advance(state: HandState): HandState {
  for (;;) {
    const live = state.players.filter((p) => !p.folded);
    if (live.length === 1) return finishUncontested(state, live[0]!);

    if (!roundComplete(state)) {
      state.toAct = nextIdx(state, state.toAct!, needsToAct(state));
      return state;
    }

    // Street over: collect bets and move on.
    for (const p of state.players) {
      p.bet = 0;
      p.lastActionSeq = -1;
    }
    state.currentBet = 0;
    state.minRaise = state.bigBlind;

    if (state.street === "river") return showdown(state);

    draw(state); // burn
    if (state.street === "preflop") {
      state.street = "flop";
      state.board.push(draw(state), draw(state), draw(state));
    } else {
      state.street = state.street === "flop" ? "turn" : "river";
      state.board.push(draw(state));
    }
    state.log.push({ type: "street", street: state.street, board: [...state.board] });

    // Postflop, the first player left of the button acts.
    state.toAct = state.buttonIdx;
  }
}

export function legalActions(state: HandState): LegalActions | null {
  if (state.toAct === null) return null;
  const p = state.players[state.toAct]!;
  const toCall = Math.max(0, state.currentBet - p.bet);
  const callAmount = Math.min(toCall, p.stack);
  const raiseRightsOpen = p.lastActionSeq < state.lastFullRaiseSeq || p.lastActionSeq < 0;
  const othersCanAct = state.players.some((o) => o !== p && canAct(o));
  const maxRaiseTo = p.bet + p.stack;
  const canRaise = p.stack > toCall && raiseRightsOpen && othersCanAct;
  return {
    playerId: p.playerId,
    canFold: true,
    canCheck: toCall === 0,
    callAmount,
    canRaise,
    minRaiseTo: canRaise ? Math.min(state.currentBet + state.minRaise, maxRaiseTo) : 0,
    maxRaiseTo: canRaise ? maxRaiseTo : 0,
  };
}

export function applyAction(prev: HandState, playerId: string, action: Action): HandState {
  const legal = legalActions(prev);
  if (!legal) throw new IllegalActionError("Hand is complete");
  if (legal.playerId !== playerId) throw new IllegalActionError("Not your turn");

  const state = structuredClone(prev);
  const p = state.players[state.toAct!]!;
  let amount = 0;
  let fullRaise = false;

  switch (action.type) {
    case "fold":
      p.folded = true;
      break;
    case "check":
      if (!legal.canCheck) throw new IllegalActionError("Cannot check facing a bet");
      break;
    case "call":
      if (legal.canCheck) throw new IllegalActionError("Nothing to call");
      amount = commit(p, legal.callAmount);
      break;
    case "raise": {
      const to = action.to;
      if (!legal.canRaise) throw new IllegalActionError("Raising is not allowed here");
      if (!Number.isInteger(to)) throw new IllegalActionError("Amount must be a whole number");
      if (to > legal.maxRaiseTo) throw new IllegalActionError(`Cannot raise to more than ${legal.maxRaiseTo}`);
      if (to < legal.minRaiseTo) throw new IllegalActionError(`Minimum raise is to ${legal.minRaiseTo}`);
      const raiseSize = to - state.currentBet;
      amount = commit(p, to - p.bet);
      if (raiseSize >= state.minRaise) {
        state.minRaise = raiseSize;
        fullRaise = true;
      }
      state.currentBet = to;
      break;
    }
  }

  p.lastActionSeq = ++state.actionSeq;
  if (fullRaise) state.lastFullRaiseSeq = state.actionSeq;
  state.log.push({ type: "action", playerId, action, amount, allIn: p.allIn });
  return advance(state);
}

/** Splits contributions into main and side pots, each with the live players eligible to win it. */
export function buildPots(players: PlayerState[]): { amount: number; eligible: PlayerState[] }[] {
  const levels = [...new Set(players.map((p) => p.contributed).filter((c) => c > 0))].sort((a, b) => a - b);
  const pots: { amount: number; eligible: PlayerState[] }[] = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const p of players) amount += Math.max(0, Math.min(p.contributed, level) - prev);
    const eligible = players.filter((p) => !p.folded && p.contributed >= level);
    const last = pots[pots.length - 1];
    if (eligible.length === 0 && last) last.amount += amount; // chips no live player matched
    else if (last && sameSet(last.eligible, eligible)) last.amount += amount;
    else pots.push({ amount, eligible });
    prev = level;
  }
  return pots;
}

const sameSet = (a: PlayerState[], b: PlayerState[]) => a.length === b.length && a.every((p) => b.includes(p));

function finishUncontested(state: HandState, winner: PlayerState): HandState {
  const total = state.players.reduce((s, p) => s + p.contributed, 0);
  winner.stack += total;
  for (const p of state.players) p.bet = 0;
  state.street = "complete";
  state.toAct = null;
  state.result = {
    pots: [{ amount: total, eligible: [winner.playerId], winners: [{ playerId: winner.playerId, amount: total }] }],
    showdown: [],
    payouts: { [winner.playerId]: total },
  };
  return state;
}

function showdown(state: HandState): HandState {
  const live = state.players.filter((p) => !p.folded);
  const values = new Map(live.map((p) => [p, evaluate([...p.holeCards, ...state.board])]));
  const payouts: Record<string, number> = {};
  const pots: PotResult[] = [];

  // Odd chips go to winners in seat order starting left of the button.
  const n = state.players.length;
  const seatOrder = (p: PlayerState) => (state.players.indexOf(p) - state.buttonIdx - 1 + n) % n;

  for (const pot of buildPots(state.players)) {
    const best = Math.max(...pot.eligible.map((p) => values.get(p)!.score));
    const winners = pot.eligible.filter((p) => values.get(p)!.score === best).sort((a, b) => seatOrder(a) - seatOrder(b));
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    const result: PotResult = { amount: pot.amount, eligible: pot.eligible.map((p) => p.playerId), winners: [] };
    for (const w of winners) {
      const won = share + (remainder-- > 0 ? 1 : 0);
      w.stack += won;
      payouts[w.playerId] = (payouts[w.playerId] ?? 0) + won;
      result.winners.push({ playerId: w.playerId, amount: won });
    }
    pots.push(result);
  }

  state.street = "complete";
  state.toAct = null;
  state.result = {
    pots,
    showdown: live.map((p) => {
      const v = values.get(p)!;
      return { playerId: p.playerId, holeCards: p.holeCards, handName: v.name, best: v.best };
    }),
    payouts,
  };
  return state;
}

/**
 * What a given viewer is allowed to see: their own hole cards, everyone's cards once revealed at
 * showdown, and never the deck. Pass null for spectators.
 */
export function viewFor(state: HandState, viewerId: string | null) {
  const revealed = new Set(state.result?.showdown.map((s) => s.playerId) ?? []);
  const { deck: _deck, deckPos: _pos, ...rest } = state;
  return {
    ...rest,
    players: state.players.map((p) => ({
      ...p,
      holeCards: p.playerId === viewerId || revealed.has(p.playerId) ? p.holeCards : p.holeCards.map(() => "??"),
    })),
    legal: (() => {
      const l = legalActions(state);
      return l && l.playerId === viewerId ? l : null;
    })(),
  };
}

export type HandView = ReturnType<typeof viewFor>;
