import { describe, expect, it } from "vitest";
import { ChatError, MAX_CHAT_LENGTH, TableChats, cleanChatText } from "../src/server/chat.ts";
import { defaultConfig } from "../src/server/tournament/structure.ts";
import { Tournament, noopHooks } from "../src/server/tournament/tournament.ts";
import { describeHand } from "../src/shared/handName.ts";

const who = (userId: number, seated = true) => ({ userId, username: `p${userId}`, avatarUrl: "", isAdmin: false, seated });

describe("table chat", () => {
  it("cleans messages: trims, collapses spaces, drops control and direction-flipping characters, caps length", () => {
    expect(cleanChatText("  hi \n\n there\t ")).toBe("hi there");
    expect(cleanChatText("a‮b\u0007c")).toBe("a b c");
    expect(cleanChatText("x".repeat(500))).toHaveLength(MAX_CHAT_LENGTH);
    expect(cleanChatText(null)).toBe("");
  });

  it("refuses empty messages", () => {
    expect(() => new TableChats().say("1:1", who(1), "   ", 0)).toThrow(ChatError);
  });

  it("rate-limits each person but allows a short burst", () => {
    const c = new TableChats();
    for (let i = 0; i < 3; i++) c.say("1:1", who(1), `m${i}`, 0);
    expect(() => c.say("1:1", who(1), "too fast", 10)).toThrow(/too fast/);
    // Someone else isn't affected, and the first person can talk again after a moment.
    expect(c.say("1:1", who(2), "hi", 10).text).toBe("hi");
    expect(c.say("1:1", who(1), "ok now", 1300).text).toBe("ok now");
  });

  it("keeps a separate, capped history per table and labels spectators", () => {
    const c = new TableChats();
    c.say("1:1", who(1), "at table one", 0);
    c.say("1:2", who(2, false), "watching table two", 0);
    expect(c.history("1:1").map((m) => m.text)).toEqual(["at table one"]);
    expect(c.history("1:2")[0]).toMatchObject({ kind: "spectator", username: "p2" });
    for (let i = 0; i < 200; i++) c.dealer("1:1", `hand ${i}`, i);
    expect(c.history("1:1").length).toBeLessThanOrEqual(80);
    expect(c.history("1:1").at(-1)!.text).toBe("hand 199");
    c.drop("1:1");
    expect(c.history("1:1")).toEqual([]);
  });
});

describe("dealer hand summaries", () => {
  it("names the winner and amount when a hand ends", () => {
    const lines: string[] = [];
    const t = Tournament.create(1, defaultConfig({ startTime: 0 }), 0, { ...noopHooks, handComplete: (_table, l) => lines.push(...l) });
    for (let i = 1; i <= 2; i++) t.register({ id: i, username: `Player ${i}`, avatarUrl: "" }, 0);
    t.tick(0);
    const tb = [...t.tables.values()][0]!;
    const first = Number(tb.hand!.players[tb.hand!.toAct!]!.playerId);
    t.act(first, { type: "fold" }, 1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Hand #1: Player [12] wins \d/);
    expect(lines[0]).not.toContain(`Player ${first} wins`);
  });
});

describe("hand names", () => {
  it("describes hole cards before the flop", () => {
    expect(describeHand(["Kh", "Kd"], [])).toBe("Pocket Kings");
    expect(describeHand(["Th", "As"], [])).toBe("Ace-Ten");
    expect(describeHand(["Jh", "9h"], [])).toBe("Jack-Nine suited");
    expect(describeHand(["??", "??"], [])).toBeNull();
  });

  it("describes made hands after the flop", () => {
    expect(describeHand(["Ah", "7d"], ["As", "7c", "2h"])).toBe("Two Pair, Aces and Sevens");
    expect(describeHand(["Ah", "Ad"], ["As", "7c", "7h"])).toBe("Full House, Aces full of Sevens");
    expect(describeHand(["9h", "4d"], ["Ks", "7c", "2h"])).toBe("King high");
    expect(describeHand(["9h", "9d"], ["9s", "7c", "2h"])).toBe("Three Nines");
    expect(describeHand(["Ah", "Kh"], ["Qh", "Jh", "Th"])).toBe("Straight Flush");
  });
});
