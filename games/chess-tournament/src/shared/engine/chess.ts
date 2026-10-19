// Chess rules as a pure state machine: every function takes a state and returns a new one, and a
// state is plain JSON, so a saved game continues exactly where it stopped.
//
// Squares are numbered 0-63: a1 = 0, h1 = 7, a8 = 56, h8 = 63. Pieces use FEN letters, uppercase
// for White ("K", "Q", "R", "B", "N", "P") and lowercase for Black; an empty square is "".
// Moves travel as UCI strings: "e2e4", "e7e8q" (promotion piece last).
//
// Games end by themselves on checkmate, stalemate, threefold repetition, the fifty-move rule and
// insufficient material. Resigning, draw agreements and clocks are the tournament's business.

export type Color = "w" | "b";

export type EndReason = "checkmate" | "stalemate" | "repetition" | "fifty-move" | "insufficient";

export interface ChessState {
  board: string[];
  turn: Color;
  /** Remaining castling rights, a subset of "KQkq" in that order ("" when none). */
  castling: string;
  /** Square a pawn just skipped over (the en passant target), or null. */
  ep: number | null;
  /** Half-moves since the last capture or pawn move (fifty-move rule). */
  halfmove: number;
  fullmove: number;
  /** Moves played so far in SAN ("e4", "Nf3", "O-O", "exd8=Q#"). */
  san: string[];
  /** The same moves in UCI. */
  uci: string[];
  /** Position keys after every move (and the start), for threefold repetition. */
  positions: string[];
  /** Set once the board itself ends the game. winner null = draw. */
  end: { winner: Color | null; reason: EndReason } | null;
}

export interface Move {
  from: number;
  to: number;
  promo?: "q" | "r" | "b" | "n";
}

export class IllegalMoveError extends Error {}

const FILES = "abcdefgh";
export const squareName = (sq: number) => `${FILES[sq & 7]}${(sq >> 3) + 1}`;
export function parseSquare(s: string): number | null {
  if (!/^[a-h][1-8]$/.test(s)) return null;
  return FILES.indexOf(s[0]!) + (Number(s[1]) - 1) * 8;
}

export const colorOf = (p: string): Color | null => (p ? (p === p.toUpperCase() ? "w" : "b") : null);
const typeOf = (p: string) => p.toLowerCase();
const other = (c: Color): Color => (c === "w" ? "b" : "w");
const file = (sq: number) => sq & 7;
const rank = (sq: number) => sq >> 3;

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function fromFen(fen: string): ChessState {
  const [placement, turn, castling, ep, half, full] = fen.trim().split(/\s+/);
  const board: string[] = Array(64).fill("");
  placement!.split("/").forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += Number(ch);
      else board[(7 - i) * 8 + f++] = ch;
    }
  });
  const s: ChessState = {
    board,
    turn: turn === "b" ? "b" : "w",
    castling: castling && castling !== "-" ? castling : "",
    ep: ep && ep !== "-" ? parseSquare(ep) : null,
    halfmove: Number(half ?? 0),
    fullmove: Number(full ?? 1),
    san: [],
    uci: [],
    positions: [],
    end: null,
  };
  s.positions = [positionKey(s)];
  return s;
}

export function newGame(): ChessState {
  return fromFen(START_FEN);
}

export function toFen(s: ChessState): string {
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = "";
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = s.board[r * 8 + f]!;
      if (!p) empty++;
      else {
        if (empty) row += empty;
        empty = 0;
        row += p;
      }
    }
    rows.push(row + (empty || ""));
  }
  return `${rows.join("/")} ${s.turn} ${s.castling || "-"} ${s.ep === null ? "-" : squareName(s.ep)} ${s.halfmove} ${s.fullmove}`;
}

// ------------------------------------------------------------------ attacks

const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]] as const;
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const;
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

const offset = (sq: number, df: number, dr: number) => {
  const f = file(sq) + df;
  const r = rank(sq) + dr;
  return f < 0 || f > 7 || r < 0 || r > 7 ? -1 : r * 8 + f;
};

/** Is `sq` attacked by any piece of color `by`? */
export function attacked(board: string[], sq: number, by: Color): boolean {
  const own = (p: string, t: string) => p !== "" && colorOf(p) === by && typeOf(p) === t;
  // Pawns attack diagonally forward, so look diagonally backward from the square.
  const back = by === "w" ? -1 : 1;
  for (const df of [-1, 1]) {
    const from = offset(sq, df, back);
    if (from >= 0 && own(board[from]!, "p")) return true;
  }
  for (const [df, dr] of KNIGHT) {
    const from = offset(sq, df, dr);
    if (from >= 0 && own(board[from]!, "n")) return true;
  }
  for (const [df, dr] of KING) {
    const from = offset(sq, df, dr);
    if (from >= 0 && own(board[from]!, "k")) return true;
  }
  const slide = (dirs: readonly (readonly [number, number])[], types: string[]) => {
    for (const [df, dr] of dirs) {
      let cur = offset(sq, df, dr);
      while (cur >= 0) {
        const p = board[cur]!;
        if (p) {
          if (colorOf(p) === by && types.includes(typeOf(p))) return true;
          break;
        }
        cur = offset(cur, df, dr);
      }
    }
    return false;
  };
  return slide(ROOK_DIRS, ["r", "q"]) || slide(BISHOP_DIRS, ["b", "q"]);
}

const kingSquare = (board: string[], c: Color) => board.indexOf(c === "w" ? "K" : "k");

export function inCheck(s: ChessState, c: Color = s.turn): boolean {
  const k = kingSquare(s.board, c);
  return k >= 0 && attacked(s.board, k, other(c));
}

// ------------------------------------------------------------------ move generation

/** Moves that follow how the pieces move, ignoring whether they leave the king in check. */
function pseudoMoves(s: ChessState): Move[] {
  const moves: Move[] = [];
  const b = s.board;
  const me = s.turn;
  const push = (from: number, to: number) => {
    if (typeOf(b[from]!) === "p" && (rank(to) === 7 || rank(to) === 0)) {
      for (const promo of ["q", "r", "b", "n"] as const) moves.push({ from, to, promo });
    } else moves.push({ from, to });
  };
  for (let from = 0; from < 64; from++) {
    const p = b[from]!;
    if (!p || colorOf(p) !== me) continue;
    const t = typeOf(p);
    if (t === "p") {
      const dir = me === "w" ? 1 : -1;
      const one = offset(from, 0, dir);
      if (one >= 0 && !b[one]) {
        push(from, one);
        const startRank = me === "w" ? 1 : 6;
        const two = offset(from, 0, 2 * dir);
        if (rank(from) === startRank && !b[two]) moves.push({ from, to: two });
      }
      for (const df of [-1, 1]) {
        const to = offset(from, df, dir);
        if (to < 0) continue;
        if ((b[to] && colorOf(b[to]!) !== me) || to === s.ep) push(from, to);
      }
    } else if (t === "n" || t === "k") {
      for (const [df, dr] of t === "n" ? KNIGHT : KING) {
        const to = offset(from, df, dr);
        if (to >= 0 && colorOf(b[to]!) !== me) moves.push({ from, to });
      }
      if (t === "k") castlingMoves(s, from, moves);
    } else {
      const dirs = t === "r" ? ROOK_DIRS : t === "b" ? BISHOP_DIRS : [...ROOK_DIRS, ...BISHOP_DIRS];
      for (const [df, dr] of dirs) {
        let to = offset(from, df, dr);
        while (to >= 0) {
          if (b[to]) {
            if (colorOf(b[to]!) !== me) moves.push({ from, to });
            break;
          }
          moves.push({ from, to });
          to = offset(to, df, dr);
        }
      }
    }
  }
  return moves;
}

function castlingMoves(s: ChessState, from: number, moves: Move[]) {
  const me = s.turn;
  const home = me === "w" ? 4 : 60;
  if (from !== home) return;
  const opp = other(me);
  const b = s.board;
  const [kSide, qSide] = me === "w" ? ["K", "Q"] : ["k", "q"];
  const rook = me === "w" ? "R" : "r";
  if (attacked(b, home, opp)) return;
  if (s.castling.includes(kSide!) && b[home + 3] === rook && !b[home + 1] && !b[home + 2] && !attacked(b, home + 1, opp) && !attacked(b, home + 2, opp))
    moves.push({ from, to: home + 2 });
  if (s.castling.includes(qSide!) && b[home - 4] === rook && !b[home - 1] && !b[home - 2] && !b[home - 3] && !attacked(b, home - 1, opp) && !attacked(b, home - 2, opp))
    moves.push({ from, to: home - 2 });
}

/** The board after a move, without any bookkeeping. */
function movedBoard(s: ChessState, m: Move): string[] {
  const b = [...s.board];
  const p = b[m.from]!;
  const t = typeOf(p);
  if (t === "p" && m.to === s.ep && !b[m.to]) b[m.to + (s.turn === "w" ? -8 : 8)] = ""; // en passant
  if (t === "k" && Math.abs(m.to - m.from) === 2) {
    // Castling: the rook jumps over the king.
    const kingSide = m.to > m.from;
    const rookFrom = kingSide ? m.from + 3 : m.from - 4;
    const rookTo = kingSide ? m.from + 1 : m.from - 1;
    b[rookTo] = b[rookFrom]!;
    b[rookFrom] = "";
  }
  b[m.to] = m.promo ? (s.turn === "w" ? m.promo.toUpperCase() : m.promo) : p;
  b[m.from] = "";
  return b;
}

export function legalMoves(s: ChessState): Move[] {
  if (s.end) return [];
  return pseudoMoves(s).filter((m) => {
    const b = movedBoard(s, m);
    const k = kingSquare(b, s.turn);
    return !attacked(b, k, other(s.turn));
  });
}

export const moveToUci = (m: Move) => `${squareName(m.from)}${squareName(m.to)}${m.promo ?? ""}`;

export function parseUci(uci: unknown): Move | null {
  if (typeof uci !== "string") return null;
  const m = uci.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/);
  if (!m) return null;
  return { from: parseSquare(m[1]!)!, to: parseSquare(m[2]!)!, ...(m[3] ? { promo: m[3] as Move["promo"] } : {}) };
}

export function legalUci(s: ChessState): string[] {
  return legalMoves(s).map(moveToUci);
}

// ------------------------------------------------------------------ playing

/** The position for repetition purposes: pieces, side to move, castling rights and a usable en passant. */
function positionKey(s: ChessState): string {
  let ep = "-";
  if (s.ep !== null) {
    // Only counts when a pawn could actually take en passant.
    const pawn = s.turn === "w" ? "P" : "p";
    const from = s.ep + (s.turn === "w" ? -8 : 8);
    if ([-1, 1].some((df) => offset(from, df, 0) >= 0 && s.board[offset(from, df, 0)] === pawn)) ep = squareName(s.ep);
  }
  return `${s.board.map((p) => p || ".").join("")} ${s.turn} ${s.castling} ${ep}`;
}

/** Neither side can ever checkmate: K v K, K+minor v K, or only same-colored bishops. */
export function insufficientMaterial(board: string[]): boolean {
  const pieces = board.flatMap((p, sq) => (p && typeOf(p) !== "k" ? [{ t: typeOf(p), sq }] : []));
  if (pieces.some((p) => p.t === "p" || p.t === "r" || p.t === "q")) return false;
  if (pieces.length <= 1) return true;
  // Any number of bishops, all on the same square color.
  const squareColor = (sq: number) => (file(sq) + rank(sq)) % 2;
  return pieces.every((p) => p.t === "b") && new Set(pieces.map((p) => squareColor(p.sq))).size === 1;
}

/** Could `c` checkmate at all if the other side ran out of time? (Losing on time is a draw if not.) */
export function canMate(board: string[], c: Color): boolean {
  const mine = board.filter((p) => p && colorOf(p) === c && typeOf(p) !== "k").map(typeOf);
  if (mine.some((t) => t === "p" || t === "r" || t === "q")) return true;
  if (mine.length >= 2) return true;
  if (mine.length === 0) return false;
  // A lone knight or bishop can only mate with the opponent's own pieces in the way.
  return board.some((p) => p && colorOf(p) !== c && typeOf(p) !== "k");
}

function san(s: ChessState, m: Move, legal: Move[]): string {
  const p = s.board[m.from]!;
  const t = typeOf(p);
  if (t === "k" && Math.abs(m.to - m.from) === 2) return m.to > m.from ? "O-O" : "O-O-O";
  const capture = Boolean(s.board[m.to]) || (t === "p" && m.to === s.ep);
  let out = "";
  if (t === "p") {
    if (capture) out += FILES[file(m.from)];
  } else {
    out += t.toUpperCase();
    // Disambiguate when another piece of the same type can reach the same square.
    const rivals = legal.filter((o) => o.to === m.to && o.from !== m.from && s.board[o.from] === p);
    if (rivals.length) {
      if (!rivals.some((o) => file(o.from) === file(m.from))) out += FILES[file(m.from)];
      else if (!rivals.some((o) => rank(o.from) === rank(m.from))) out += rank(m.from) + 1;
      else out += squareName(m.from);
    }
  }
  if (capture) out += "x";
  out += squareName(m.to);
  if (m.promo) out += `=${m.promo.toUpperCase()}`;
  return out;
}

/** Plays a move (UCI string or Move). Throws IllegalMoveError if it isn't legal. */
export function applyMove(s: ChessState, input: string | Move): ChessState {
  if (s.end) throw new IllegalMoveError("The game is over");
  const want = typeof input === "string" ? parseUci(input) : input;
  if (!want) throw new IllegalMoveError("Not a move");
  const legal = legalMoves(s);
  // A pawn reaching the last rank without a piece named becomes a queen.
  const m = legal.find((l) => l.from === want.from && l.to === want.to && (l.promo ?? null) === (want.promo ?? (l.promo ? "q" : null)));
  if (!m) throw new IllegalMoveError("That move isn't legal");

  const p = s.board[m.from]!;
  const t = typeOf(p);
  const capture = Boolean(s.board[m.to]) || (t === "p" && m.to === s.ep);
  let notation = san(s, m, legal);

  // Castling rights go when the king or a rook moves, or a rook is captured on its home square.
  const lost: Record<number, string> = { 4: "KQ", 0: "Q", 7: "K", 60: "kq", 56: "q", 63: "k" };
  let castling = s.castling;
  for (const sq of [m.from, m.to]) for (const ch of lost[sq] ?? "") castling = castling.replace(ch, "");

  const next: ChessState = {
    board: movedBoard(s, m),
    turn: other(s.turn),
    castling,
    ep: t === "p" && Math.abs(m.to - m.from) === 16 ? (m.from + m.to) / 2 : null,
    halfmove: t === "p" || capture ? 0 : s.halfmove + 1,
    fullmove: s.fullmove + (s.turn === "b" ? 1 : 0),
    san: s.san,
    uci: [...s.uci, moveToUci(m)],
    positions: s.positions,
    end: null,
  };
  const key = positionKey(next);
  // A capture or pawn move makes every earlier position unreachable, so the list can restart.
  next.positions = next.halfmove === 0 ? [key] : [...s.positions, key];

  const replies = legalMoves(next);
  const check = inCheck(next);
  if (!replies.length) next.end = check ? { winner: s.turn, reason: "checkmate" } : { winner: null, reason: "stalemate" };
  else if (insufficientMaterial(next.board)) next.end = { winner: null, reason: "insufficient" };
  else if (next.positions.filter((k) => k === key).length >= 3) next.end = { winner: null, reason: "repetition" };
  else if (next.halfmove >= 100) next.end = { winner: null, reason: "fifty-move" };

  if (check) notation += replies.length ? "+" : "#";
  next.san = [...s.san, notation];
  return next;
}

/** Counts move paths to a depth; the standard way to check a move generator. */
export function perft(s: ChessState, depth: number): number {
  if (depth === 0) return 1;
  const moves = legalMoves(s);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) n += perft({ ...applyMoveFast(s, m) }, depth - 1);
  return n;
}

/** applyMove without SAN or end-of-game checks, for perft. */
function applyMoveFast(s: ChessState, m: Move): ChessState {
  const t = typeOf(s.board[m.from]!);
  const lost: Record<number, string> = { 4: "KQ", 0: "Q", 7: "K", 60: "kq", 56: "q", 63: "k" };
  let castling = s.castling;
  for (const sq of [m.from, m.to]) for (const ch of lost[sq] ?? "") castling = castling.replace(ch, "");
  return {
    ...s,
    board: movedBoard(s, m),
    turn: other(s.turn),
    castling,
    ep: t === "p" && Math.abs(m.to - m.from) === 16 ? (m.from + m.to) / 2 : null,
    end: null,
  };
}

/** A small seeded random number generator (mulberry32), so tests and bots are repeatable. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
