// One Uno hand as a pure state machine: startGame() deals, applyAction() returns the next state.
// No I/O and no Math.random: shuffles use the seeded generator stored in the state, so a saved game
// continues exactly as it would have, and tests are repeatable.
//
// Official rules, plus an optional "stacking" house rule:
// - Match the top card by color or value, or play a Wild. Wild Draw Four only when you hold no card of
//   the current color.
// - Can't (or don't want to) play: draw one. If it's playable you may play it straight away, otherwise
//   your turn ends.
// - Skip skips the next player, Reverse changes direction (with two players it acts as a Skip), Draw
//   Two / Wild Draw Four make the next player draw and lose their turn.
// - Stacking on: instead of drawing, the next player may pass the penalty on with another Draw Two (on a
//   Draw Two) or a Wild Draw Four (on either). Whoever finally draws takes the total and loses their turn.
// - UNO: play down to one card without calling UNO and anyone can catch you before the next player acts:
//   you draw two.

import { type Card, type Color, COLORS, COLOR_NAMES, cardName, colorOf, fullDeck, isCard, isDraw, isWild, shuffle, valueOf } from "./cards.ts";

export const HAND_SIZE = 7;
export const UNO_PENALTY = 2;

export interface GamePlayer {
  playerId: string;
  /** The table seat (for the views). */
  seat: number;
  hand: Card[];
  /** Called UNO for their current (or coming) last card. Reset when they hold more than two again. */
  calledUno: boolean;
}

export type GameEvent =
  | { type: "play"; playerId: string; card: Card; color: Color | null }
  | { type: "draw"; playerId: string; count: number; forced: boolean }
  | { type: "pass"; playerId: string }
  | { type: "skip"; playerId: string }
  | { type: "reverse" }
  | { type: "uno"; playerId: string }
  | { type: "caught"; playerId: string; by: string }
  | { type: "win"; playerId: string };

export interface GameState {
  /** In seat order. */
  players: GamePlayer[];
  drawPile: Card[];
  /** Top card is the last one. */
  discard: Card[];
  /** The color to match (a Wild's chosen color, otherwise the top card's). */
  color: Color;
  /** Index into players of whose turn it is. */
  turn: number;
  direction: 1 | -1;
  /** Stacking only: cards the current player must draw unless they pass it on. */
  pendingDraw: number;
  /** The card the current player just drew and may play (or pass). */
  drawn: Card | null;
  /** A player who went down to one card without calling UNO; catchable until the next player acts. */
  unoVulnerable: string | null;
  stacking: boolean;
  winner: string | null;
  /** Recent events, newest last (for the table view and chat). */
  log: GameEvent[];
  rng: number;
}

export type Action =
  | { type: "play"; card: Card; color?: Color; uno?: boolean }
  | { type: "draw" }
  | { type: "pass" }
  | { type: "uno" }
  | { type: "catch"; playerId: string };

export class IllegalActionError extends Error {}

const LOG_LENGTH = 12;

export interface StartOptions {
  players: { playerId: string; seat: number }[];
  /** Index into players of the dealer; the player after them starts. */
  dealer: number;
  stacking: boolean;
  seed: number;
}

export function startGame(opts: StartOptions): GameState {
  if (opts.players.length < 2) throw new Error("Uno needs at least two players");
  const g: GameState = {
    players: opts.players.map((p) => ({ playerId: p.playerId, seat: p.seat, hand: [], calledUno: false })),
    drawPile: [],
    discard: [],
    color: "r",
    turn: 0,
    direction: 1,
    pendingDraw: 0,
    drawn: null,
    unoVulnerable: null,
    stacking: opts.stacking,
    winner: null,
    log: [],
    rng: opts.seed | 0,
  };
  g.drawPile = shuffle(fullDeck(), g);
  for (let i = 0; i < HAND_SIZE; i++) for (const p of g.players) p.hand.push(g.drawPile.pop()!);

  // Flip the first card. Wilds go back into the pile so the first player always has a color to match.
  let first = g.drawPile.pop()!;
  while (isWild(first)) {
    g.drawPile.unshift(first);
    shuffle(g.drawPile, g);
    first = g.drawPile.pop()!;
  }
  g.discard.push(first);
  g.color = colorOf(first)!;
  g.turn = (opts.dealer + 1) % g.players.length;

  // The first card's action applies to the first player, as in the official rules.
  const v = valueOf(first);
  if (v === "S") {
    log(g, { type: "skip", playerId: current(g).playerId });
    advance(g, 1);
  } else if (v === "R") {
    log(g, { type: "reverse" });
    g.direction = -1;
    g.turn = g.players.length === 2 ? (opts.dealer + 1) % g.players.length : opts.dealer;
    if (g.players.length === 2) advance(g, 1);
  } else if (v === "D") {
    forceDraw(g, 2);
  }
  return g;
}

export const current = (g: GameState) => g.players[g.turn]!;
export const topCard = (g: GameState) => g.discard[g.discard.length - 1]!;

/** Whether `card` may be played by the current player right now (ignores whether they hold it). */
export function canPlay(g: GameState, hand: Card[], card: Card): boolean {
  if (g.winner) return false;
  if (g.drawn !== null && card !== g.drawn) return false;
  if (g.pendingDraw > 0) return card === "W4" || (valueOf(card) === "D" && valueOf(topCard(g)) === "D");
  if (card === "W") return true;
  if (card === "W4") return !hand.some((c) => colorOf(c) === g.color);
  const top = topCard(g);
  return colorOf(card) === g.color || (!isWild(top) && valueOf(card) === valueOf(top));
}

/** The distinct cards in the current player's hand they may play. */
export function playableCards(g: GameState): Card[] {
  const hand = current(g).hand;
  return [...new Set(hand)].filter((c) => canPlay(g, hand, c));
}

export interface LegalActions {
  playerId: string;
  playable: Card[];
  /** False after drawing (then it's play the drawn card or pass). */
  canDraw: boolean;
  canPass: boolean;
  /** Stacking: what drawing now would cost. 0 = a normal one-card draw. */
  pendingDraw: number;
  drawn: Card | null;
}

export function legalActions(g: GameState): LegalActions | null {
  if (g.winner) return null;
  const p = current(g);
  return {
    playerId: p.playerId,
    playable: playableCards(g),
    canDraw: g.drawn === null,
    canPass: g.drawn !== null,
    pendingDraw: g.pendingDraw,
    drawn: g.drawn,
  };
}

/** Applies one player's action and returns the new state. Throws IllegalActionError if it isn't allowed. */
export function applyAction(state: GameState, playerId: string, action: Action): GameState {
  if (state.winner) throw new IllegalActionError("The hand is over");
  const g = structuredClone(state);
  const actor = g.players.find((p) => p.playerId === playerId);
  if (!actor) throw new IllegalActionError("You are not in this hand");

  // Calling UNO and catching someone can happen out of turn.
  if (action.type === "uno") {
    if (actor.hand.length > 2) throw new IllegalActionError("You can call UNO when you have one or two cards");
    if (actor.calledUno) return state;
    actor.calledUno = true;
    if (g.unoVulnerable === playerId) g.unoVulnerable = null;
    log(g, { type: "uno", playerId });
    return g;
  }
  if (action.type === "catch") {
    const target = g.players.find((p) => p.playerId === action.playerId);
    if (!target || target === actor) throw new IllegalActionError("Nobody to catch");
    if (g.unoVulnerable !== target.playerId) throw new IllegalActionError("Too late: they're safe");
    g.unoVulnerable = null;
    drawInto(g, target, UNO_PENALTY);
    log(g, { type: "caught", playerId: target.playerId, by: playerId });
    return g;
  }

  if (current(g) !== actor) throw new IllegalActionError("It's not your turn");
  // The next player acting closes the window for catching the previous one.
  if (g.unoVulnerable !== playerId) g.unoVulnerable = null;

  switch (action.type) {
    case "play":
      play(g, actor, action);
      break;
    case "draw":
      if (g.drawn !== null) throw new IllegalActionError("You've already drawn: play that card or pass");
      if (g.pendingDraw > 0) {
        const n = g.pendingDraw;
        g.pendingDraw = 0;
        drawInto(g, actor, n);
        log(g, { type: "draw", playerId, count: n, forced: true });
        advance(g, 1);
      } else {
        const [card] = drawInto(g, actor, 1);
        log(g, { type: "draw", playerId, count: card ? 1 : 0, forced: false });
        if (card && canPlay(g, actor.hand, card)) g.drawn = card;
        else advance(g, 1);
      }
      break;
    case "pass":
      if (g.drawn === null) throw new IllegalActionError("Draw a card first");
      g.drawn = null;
      log(g, { type: "pass", playerId });
      advance(g, 1);
      break;
    default:
      throw new IllegalActionError("Unknown action");
  }
  return g;
}

function play(g: GameState, p: GamePlayer, action: Extract<Action, { type: "play" }>) {
  const { card } = action;
  if (!isCard(card) || !p.hand.includes(card)) throw new IllegalActionError("You don't have that card");
  if (!canPlay(g, p.hand, card)) {
    if (g.drawn !== null) throw new IllegalActionError("You can only play the card you just drew, or pass");
    if (g.pendingDraw > 0) throw new IllegalActionError(`Stack a draw card or draw ${g.pendingDraw}`);
    if (card === "W4") throw new IllegalActionError(`You can only play Wild Draw Four when you have no ${COLOR_NAMES[g.color]} cards`);
    throw new IllegalActionError("That card doesn't match");
  }
  if (isWild(card) && !(action.color && (COLORS as readonly string[]).includes(action.color))) throw new IllegalActionError("Pick a color");

  p.hand.splice(p.hand.indexOf(card), 1);
  g.discard.push(card);
  g.drawn = null;
  g.color = isWild(card) ? action.color! : colorOf(card)!;
  if (action.uno && p.hand.length <= 1) p.calledUno = true;
  log(g, { type: "play", playerId: p.playerId, card, color: isWild(card) ? g.color : null });

  if (p.hand.length === 0) {
    g.winner = p.playerId;
    g.unoVulnerable = null;
    g.pendingDraw = 0;
    log(g, { type: "win", playerId: p.playerId });
    return;
  }
  if (p.hand.length === 1 && !p.calledUno) g.unoVulnerable = p.playerId;
  if (p.hand.length > 2) p.calledUno = false;

  const v = valueOf(card);
  if (v === "S") {
    advance(g, 1);
    log(g, { type: "skip", playerId: current(g).playerId });
    advance(g, 1);
  } else if (v === "R") {
    g.direction = g.direction === 1 ? -1 : 1;
    log(g, { type: "reverse" });
    advance(g, g.players.length === 2 ? 2 : 1);
  } else if (isDraw(card)) {
    const n = card === "W4" ? 4 : 2;
    advance(g, 1);
    if (g.stacking) g.pendingDraw += n;
    else forceDraw(g, n);
  } else {
    advance(g, 1);
  }
}

/** The current player draws n and loses their turn. */
function forceDraw(g: GameState, n: number) {
  const victim = current(g);
  drawInto(g, victim, n);
  log(g, { type: "draw", playerId: victim.playerId, count: n, forced: true });
  advance(g, 1);
}

/** Moves cards from the draw pile into a hand, reshuffling the discards when it runs out. */
function drawInto(g: GameState, p: GamePlayer, n: number): Card[] {
  const got: Card[] = [];
  for (let i = 0; i < n; i++) {
    if (!g.drawPile.length) {
      if (g.discard.length <= 1) break; // every card is in someone's hand
      const top = g.discard.pop()!;
      g.drawPile = shuffle(g.discard, g);
      g.discard = [top];
    }
    got.push(g.drawPile.pop()!);
  }
  p.hand.push(...got);
  if (p.hand.length > 2) p.calledUno = false;
  if (g.unoVulnerable === p.playerId && p.hand.length > 1) g.unoVulnerable = null;
  return got;
}

function advance(g: GameState, steps: number) {
  const n = g.players.length;
  g.turn = (((g.turn + g.direction * steps) % n) + n) % n;
  g.drawn = null;
}

function log(g: GameState, e: GameEvent) {
  g.log.push(e);
  if (g.log.length > LOG_LENGTH) g.log.splice(0, g.log.length - LOG_LENGTH);
}

/**
 * Takes a player out of a hand (kicked by an admin): their cards go under the draw pile. If one player
 * is left they win the hand.
 */
export function removePlayer(state: GameState, playerId: string): GameState {
  const g = structuredClone(state);
  const idx = g.players.findIndex((p) => p.playerId === playerId);
  if (idx < 0 || g.winner) return state;
  const [gone] = g.players.splice(idx, 1);
  g.drawPile.unshift(...gone!.hand);
  if (g.unoVulnerable === playerId) g.unoVulnerable = null;
  if (idx < g.turn) g.turn--;
  else if (idx === g.turn) {
    g.drawn = null;
    g.pendingDraw = 0;
    if (g.direction === -1) g.turn--;
  }
  g.turn = ((g.turn % g.players.length) + g.players.length) % g.players.length;
  if (g.players.length === 1) {
    g.winner = g.players[0]!.playerId;
    log(g, { type: "win", playerId: g.winner });
  }
  return g;
}

/**
 * A reasonable move for the current player: what the server plays for someone who timed out or is
 * away, and what the test bots play. Prefers action cards, then the color it holds most of, keeping
 * wilds for last; picks its strongest color for a wild; always calls UNO.
 */
export function autoAction(g: GameState): Action {
  const p = current(g);
  const playable = playableCards(g);
  if (!playable.length) return g.drawn !== null ? { type: "pass" } : { type: "draw" };
  const counts = new Map<Color, number>();
  for (const c of p.hand) {
    const col = colorOf(c);
    if (col) counts.set(col, (counts.get(col) ?? 0) + 1);
  }
  const rank = (c: Card) => (isWild(c) ? -100 + (c === "W" ? 1 : 0) : (/^\d$/.test(valueOf(c)) ? 0 : 5) + (counts.get(colorOf(c)!) ?? 0));
  const card = [...playable].sort((a, b) => rank(b) - rank(a))[0]!;
  const best = [...COLORS].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))[0]!;
  return { type: "play", card, ...(isWild(card) ? { color: best } : {}), uno: p.hand.length === 2 };
}

/** A line of text for one event, e.g. "Alex played Wild Draw Four (blue)". */
export function describeEvent(e: GameEvent, name: (playerId: string) => string): string {
  switch (e.type) {
    case "play":
      return `${name(e.playerId)} played ${cardName(e.card)}${e.color ? ` → ${COLOR_NAMES[e.color]}` : ""}`;
    case "draw":
      return e.forced ? `${name(e.playerId)} draws ${e.count} and is skipped` : `${name(e.playerId)} drew a card`;
    case "pass":
      return `${name(e.playerId)} passed`;
    case "skip":
      return `${name(e.playerId)} is skipped`;
    case "reverse":
      return "Direction reversed";
    case "uno":
      return `${name(e.playerId)}: UNO!`;
    case "caught":
      return `${name(e.by)} caught ${name(e.playerId)} without UNO: +${UNO_PENALTY} cards`;
    case "win":
      return `${name(e.playerId)} wins the hand!`;
  }
}

/** Every card in the game, for sanity checks in tests: always the full 108. */
export function cardCount(g: GameState) {
  return g.drawPile.length + g.discard.length + g.players.reduce((n, p) => n + p.hand.length, 0);
}

