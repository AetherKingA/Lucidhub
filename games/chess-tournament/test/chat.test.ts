import { describe, expect, it } from "vitest";
import { ChatError, MAX_CHAT_LENGTH, TableChats, chatRights, cleanChatText, defaultChannel, messageKind } from "../src/server/chat.ts";

const who = (userId: number, seated = true, isAdmin = false) => ({ userId, username: `p${userId}`, avatarUrl: "", isAdmin, seated });

describe("table chat", () => {
  it("cleans messages: trims, collapses spaces, drops control characters, caps length", () => {
    expect(cleanChatText("  hi \n\n there\t ")).toBe("hi there");
    expect(cleanChatText("x".repeat(500))).toHaveLength(MAX_CHAT_LENGTH);
    expect(cleanChatText(null)).toBe("");
  });

  it("refuses empty messages and rate-limits each person", () => {
    const c = new TableChats();
    expect(() => c.say("1:1", "table", who(1), "   ", 0)).toThrow(ChatError);
    for (let i = 0; i < 3; i++) c.say("1:1", "table", who(1), `m${i}`, 0);
    expect(() => c.say("1:1", "table", who(1), "too fast", 10)).toThrow(/too fast/);
  });

  it("keeps a separate, capped history per board and channel; arbiter lines go to the players' chat", () => {
    const c = new TableChats();
    c.say("1:1", "table", who(1), "at table one", 0);
    c.say("1:1", "spectators", who(2, false), "watching", 0);
    expect(c.history("1:1", "table").map((m) => m.text)).toEqual(["at table one"]);
    expect(c.history("1:1", "spectators")[0]).toMatchObject({ kind: "spectator", username: "p2" });
    for (let i = 0; i < 200; i++) c.dealer("1:1", `hand ${i}`, i);
    expect(c.history("1:1", "table").length).toBeLessThanOrEqual(80);
    expect(c.history("1:1", "spectators")).toHaveLength(1);
    c.drop("1:1");
    expect(c.history("1:1", "table")).toEqual([]);
    expect(c.history("1:1", "spectators")).toEqual([]);
  });
});

describe("who can read and post where", () => {
  it("keeps seated players out of the spectator chat; the host may talk to the table", () => {
    expect(chatRights({ seated: true, isAdmin: true })).toEqual({ read: ["table"], post: ["table"] });
    expect(chatRights({ seated: false, isAdmin: false })).toEqual({ read: ["table", "spectators"], post: ["spectators"] });
    expect(chatRights({ seated: false, isAdmin: true })).toEqual({ read: ["table", "spectators"], post: ["table", "spectators"] });
    expect(messageKind("table", { seated: false, isAdmin: true })).toBe("host");
    expect(defaultChannel({ seated: false, isAdmin: false })).toBe("spectators");
  });

  it("refuses posts in a channel you can't use", () => {
    const c = new TableChats();
    expect(() => c.say("1:1", "spectators", who(1, true), "psst", 0)).toThrow(/Players can't post/);
    expect(() => c.say("1:1", "table", who(2, false), "Qxf7 is mate!", 0)).toThrow(/Only players and the host/);
    expect(c.say("1:1", "table", who(3, false, true), "Break in 5 minutes", 0)).toMatchObject({ kind: "host" });
  });
});
