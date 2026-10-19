import { describe, expect, it } from "vitest";
import { IllegalMoveError, applyMove, canMate, fromFen, inCheck, legalUci, newGame, perft, toFen } from "../src/shared/engine/chess.ts";

const play = (fen: string | null, moves: string[]) => moves.reduce((s, m) => applyMove(s, m), fen ? fromFen(fen) : newGame());

describe("move generation (perft)", () => {
  // Reference counts from https://www.chessprogramming.org/Perft_Results
  it("start position", () => {
    const s = newGame();
    expect([1, 2, 3].map((d) => perft(s, d))).toEqual([20, 400, 8902]);
  });

  it("Kiwipete: castling, en passant, promotions, pins", () => {
    const s = fromFen("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1");
    expect([1, 2, 3].map((d) => perft(s, d))).toEqual([48, 2039, 97862]);
  });

  it("position 3: en passant discovered checks", () => {
    const s = fromFen("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1");
    expect([1, 2, 3, 4].map((d) => perft(s, d))).toEqual([14, 191, 2812, 43238]);
  });

  it("position 4: promotions and castling under attack", () => {
    const s = fromFen("r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1");
    expect([1, 2, 3].map((d) => perft(s, d))).toEqual([6, 264, 9467]);
  });
});

describe("playing moves", () => {
  it("writes SAN, FEN and tracks castling and en passant", () => {
    const s = play(null, ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "e1g1"]);
    expect(s.san).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "O-O"]);
    expect(toFen(s)).toBe("r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 5 4");
    const ep = play(null, ["e2e4", "a7a6", "e4e5", "d7d5", "e5d6"]);
    expect(ep.san.at(-1)).toBe("exd6");
    expect(ep.board[35]).toBe(""); // the d5 pawn is gone
  });

  it("disambiguates and promotes", () => {
    const s = play("k7/4P3/8/8/8/8/8/K1N3N1 w - - 0 1", ["c1e2"]);
    expect(s.san).toEqual(["Nce2"]);
    const promo = play("k7/4P3/8/8/8/8/8/K7 w - - 0 1", ["e7e8"]);
    expect(promo.san).toEqual(["e8=Q+"]);
    expect(play("k7/4P3/8/8/8/8/8/K7 w - - 0 1", ["e7e8n"]).board[60]).toBe("N");
  });

  it("rejects illegal moves", () => {
    expect(() => applyMove(newGame(), "e2e5")).toThrow(IllegalMoveError);
    expect(() => applyMove(newGame(), "e7e5")).toThrow(IllegalMoveError);
    // Pinned piece.
    expect(() => applyMove(fromFen("4k3/4r3/8/8/8/8/4B3/4K3 w - - 0 1"), "e2d3")).toThrow(IllegalMoveError);
    expect(() => applyMove(newGame(), "nonsense")).toThrow(IllegalMoveError);
  });

  it("can't castle out of, through or into check", () => {
    expect(legalUci(fromFen("4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1"))).toEqual(expect.arrayContaining(["e1g1", "e1c1"]));
    expect(legalUci(fromFen("4k3/4r3/8/8/8/8/8/R3K2R w KQ - 0 1"))).not.toContain("e1g1");
    expect(legalUci(fromFen("4k3/5r2/8/8/8/8/8/R3K2R w KQ - 0 1"))).not.toContain("e1g1");
    expect(legalUci(fromFen("4k3/3r4/8/8/8/8/8/R3K2R w KQ - 0 1"))).not.toContain("e1c1");
  });
});

describe("game endings", () => {
  it("fool's mate", () => {
    const s = play(null, ["f2f3", "e7e5", "g2g4", "d8h4"]);
    expect(s.end).toEqual({ winner: "b", reason: "checkmate" });
    expect(s.san.at(-1)).toBe("Qh4#");
    expect(inCheck(s)).toBe(true);
    expect(legalUci(s)).toEqual([]);
  });

  it("stalemate", () => {
    const s = play("k7/8/1Q6/8/8/8/8/7K w - - 0 1", ["b6c7"]);
    expect(s.end?.reason).toBe("stalemate");
    // Reaching b6 - c7 idea differently: still the only legal outcome is a draw.
    expect(s.end?.winner).toBeNull();
  });

  it("threefold repetition", () => {
    const shuffle = ["g1f3", "g8f6", "f3g1", "f6g8"];
    const s = play(null, [...shuffle, ...shuffle]);
    expect(s.end).toEqual({ winner: null, reason: "repetition" });
  });

  it("fifty-move rule", () => {
    const s = play("k7/8/8/8/8/8/8/K6R w - - 99 80", ["h1h2"]);
    expect(s.end).toEqual({ winner: null, reason: "fifty-move" });
  });

  it("insufficient material", () => {
    expect(play("k7/8/8/8/8/8/1r6/K7 w - - 0 1", ["a1b2"]).end).toEqual({ winner: null, reason: "insufficient" });
    expect(play("kn6/n7/8/8/8/8/1r6/K7 w - - 0 1", ["a1b2"]).end).toBeNull();
  });

  it("knows who can still mate on time", () => {
    expect(canMate(fromFen("k7/8/8/8/8/8/8/KN6 w - - 0 1").board, "w")).toBe(false);
    expect(canMate(fromFen("k7/p7/8/8/8/8/8/KN6 w - - 0 1").board, "w")).toBe(true);
    expect(canMate(fromFen("k7/8/8/8/8/8/8/KR6 w - - 0 1").board, "w")).toBe(true);
    expect(canMate(fromFen("k7/8/8/8/8/8/8/KR6 w - - 0 1").board, "b")).toBe(false);
  });
});
