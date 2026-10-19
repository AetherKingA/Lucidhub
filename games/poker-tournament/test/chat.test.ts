import { describe, expect, it } from "vitest";
import { ChatError, MAX_CHAT_LENGTH, TableChats, chatRights, cleanChatText, defaultChannel, messageKind } from "../src/server/chat.ts";
import { defaultConfig } from "../src/server/tournament/structure.ts";
import { Tournament, noopHooks } from "../src/server/tournament/tournament.ts";
import { describeHand } from "../src/shared/handName.ts";

const who = (userId: number, seated = true, isAdmin = false) => ({ userId, username: `p${userId}`, avatarUrl: "", isAdmin, seated });

describe("table chat", () => {
  it("cleans messages: trims, collapses spaces, drops control and direction-flipping characters, caps length", () => {
    expect(cleanChatText("  hi \n\n there\t ")).toBe("hi there");
    expect(cleanChatText("a‮b\u0007c")).toBe("a b c");
    expect(cleanChatText("x".repeat(500))).toHaveLength(MAX_CHAT_LENGTH);
    expect(cleanChatText(null)).toBe("");
  });

  it("refuses empty messages", () => {
    expect(() => new TableChats().say("1:1", "table", who(1), "   ", 0)).toThrow(ChatError);
  });

  it("rate-limits each person but allows a short burst", () => {
    const c = new TableChats();
    for (let i = 0; i < 3; i++) c.say("1:1", "table", who(1), `m${i}`, 0);
    expect(() => c.say("1:1", "table", who(1), "too fast", 10)).toThrow(/too fast/);
    // Someone else isn't affected, and the first person can talk again after a moment.
    expect(c.say("1:1", "table", who(2), "hi", 10).text).toBe("hi");
    expect(c.say("1:1", "table", who(1), "ok now", 1300).text).toBe("ok now");
  });

  it("keeps a separate, capped history per table and channel, and labels spectators", () => {
    const c = new TableChats();
    c.say("1:1", "table", who(1), "at table one", 0);
    c.say("1:2", "spectators", who(2, false), "watching table two", 0);
    expect(c.history("1:1", "table").map((m) => m.text)).toEqual(["at table one"]);
    expect(c.history("1:1", "spectators")).toEqual([]);
    expect(c.history("1:2", "table")).toEqual([]);
    expect(c.history("1:2", "spectators")[0]).toMatchObject({ kind: "spectator", username: "p2" });
    for (let i = 0; i < 200; i++) c.dealer("1:1", `hand ${i}`, i);
    expect(c.history("1:1", "table").length).toBeLessThanOrEqual(80);
    expect(c.history("1:1", "table").at(-1)!.text).toBe("hand 199");
    expect(c.history("1:1", "spectators")).toEqual([]);
    c.say("1:1", "spectators", who(3, false), "hi", 0);
    c.drop("1:1");
    expect(c.history("1:1", "table")).toEqual([]);
    expect(c.history("1:1", "spectators")).toEqual([]);
  });
});

describe("who can read and post where", () => {
  it("keeps seated players out of the spectator chat", () => {
    expect(chatRights({ seated: true, isAdmin: false })).toEqual({ read: ["table"], post: ["table"] });
    // Even an admin who is playing at this table.
    expect(chatRights({ seated: true, isAdmin: true })).toEqual({ read: ["table"], post: ["table"] });
  });

  it("lets spectators read both but post only with other spectators; the host may talk to the table", () => {
    expect(chatRights({ seated: false, isAdmin: false })).toEqual({ read: ["table", "spectators"], post: ["spectators"] });
    expect(chatRights({ seated: false, isAdmin: true })).toEqual({ read: ["table", "spectators"], post: ["table", "spectators"] });
  });

  it("labels messages by channel and who sent them", () => {
    expect(messageKind("table", { seated: true, isAdmin: false })).toBe("player");
    expect(messageKind("table", { seated: false, isAdmin: true })).toBe("host");
    expect(messageKind("spectators", { seated: false, isAdmin: true })).toBe("spectator");
    expect(defaultChannel({ seated: true, isAdmin: false })).toBe("table");
    expect(defaultChannel({ seated: false, isAdmin: true })).toBe("spectators");
  });

  it("refuses posts in a channel you can't use", () => {
    const c = new TableChats();
    expect(() => c.say("1:1", "spectators", who(1, true), "psst", 0)).toThrow(/Players can't post/);
    expect(() => c.say("1:1", "table", who(2, false), "fold!", 0)).toThrow(/Only players and the host/);
    expect(c.say("1:1", "table", who(3, false, true), "Break in 5 minutes", 0)).toMatchObject({ kind: "host", admin: true });
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
