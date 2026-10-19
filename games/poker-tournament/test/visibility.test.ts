// What each person at (or watching) a table is sent: nobody may see cards they shouldn't.

import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/server/tournament/structure.ts";
import { Tournament, noopHooks } from "../src/server/tournament/tournament.ts";
import type { TableState } from "../src/server/tournament/types.ts";

const HIDDEN = "??";

function startTable(players: number) {
  const t = Tournament.create(1, defaultConfig({ startTime: 0 }), 0, { ...noopHooks });
  for (let i = 1; i <= players; i++) t.register({ id: i, username: `p${i}`, avatarUrl: "" }, 0);
  t.tick(0);
  const tb = [...t.tables.values()][0]!;
  return { t, tb };
}

const actor = (tb: TableState) => Number(tb.hand!.players[tb.hand!.toAct!]!.playerId);
const cardsOf = (tb: TableState, userId: number) => tb.hand!.players.find((p) => p.playerId === String(userId))!.holeCards;

describe("what players are sent", () => {
  it("shows each player only their own hole cards, and spectators none", () => {
    const { t, tb } = startTable(6);
    for (let viewer = 1; viewer <= 6; viewer++) {
      const view = t.tableView(tb.id, viewer, 0)!;
      for (const seat of view.seats) {
        if (!seat) continue;
        if (seat.userId === viewer) expect(seat.holeCards).toEqual(cardsOf(tb, viewer));
        else expect(seat.holeCards).toEqual([HIDDEN, HIDDEN]);
      }
    }
    const spectator = t.tableView(tb.id, null, 0)!;
    for (const seat of spectator.seats) if (seat) expect(seat.holeCards).toEqual([HIDDEN, HIDDEN]);
  });

  it("never sends the deck or any undealt card", () => {
    const { t, tb } = startTable(6);
    const h = tb.hand!;
    const undealt = h.deck.slice(h.deckPos);
    expect(undealt.length).toBeGreaterThan(0);
    for (const viewer of [null, 1, 2, 3, 4, 5, 6]) {
      const json = JSON.stringify(t.tableView(tb.id, viewer, 0));
      expect(json).not.toMatch(/"deck"/);
      for (const card of undealt) expect(json).not.toContain(`"${card}"`);
      // Other players' cards don't appear anywhere in the message either.
      for (let other = 1; other <= 6; other++) {
        if (other === viewer) continue;
        for (const card of cardsOf(tb, other)) expect(json).not.toContain(`"${card}"`);
      }
    }
  });

  it("sends the action options only to the player whose turn it is", () => {
    const { t, tb } = startTable(6);
    const who = actor(tb);
    expect(t.tableView(tb.id, who, 0)!.legal).not.toBeNull();
    for (let viewer = 1; viewer <= 6; viewer++) if (viewer !== who) expect(t.tableView(tb.id, viewer, 0)!.legal).toBeNull();
    expect(t.tableView(tb.id, null, 0)!.legal).toBeNull();
  });

  it("hides a player's cards once they fold, even from themselves", () => {
    const { t, tb } = startTable(3);
    const who = actor(tb);
    t.act(who, { type: "fold" }, 1);
    for (const viewer of [null, 1, 2, 3]) {
      const seat = t.tableView(tb.id, viewer, 1)!.seats.find((s) => s?.userId === who)!;
      expect(seat.holeCards).toEqual([]);
    }
  });

  it("reveals cards only at showdown, and only for players still in the hand", () => {
    const { t, tb } = startTable(3);
    const folder = actor(tb);
    t.act(folder, { type: "fold" }, 1);
    // The other two check/call to the river.
    let now = 2;
    while (tb.hand && tb.hand.street !== "complete") {
      const who = actor(tb);
      const l = t.tableView(tb.id, who, now)!.legal!;
      // Before the hand ends, the other live player's cards stay hidden.
      const other = tb.hand.players.find((p) => !p.folded && p.playerId !== String(who))!;
      expect(t.tableView(tb.id, who, now)!.seats.find((s) => s?.userId === Number(other.playerId))!.holeCards).toEqual([HIDDEN, HIDDEN]);
      t.act(who, l.canCheck ? { type: "check" } : { type: "call" }, now++);
    }
    const shown = t.tableView(tb.id, null, now)!;
    for (const seat of shown.seats) {
      if (!seat) continue;
      if (seat.userId === folder) expect(seat.holeCards).toEqual([]);
      else expect(seat.holeCards).toEqual(cardsOf(tb, seat.userId));
    }
  });
});

describe("host view (admins who aren't playing see every hand)", () => {
  const ADMIN = 99;
  const admin = { id: ADMIN, isAdmin: true };

  it("is only for admins with no stake in the tournament, and only while it runs", () => {
    const t = Tournament.create(1, defaultConfig({ startTime: 1000 }), 0, { ...noopHooks });
    for (let i = 1; i <= 7; i++) t.register({ id: i, username: `p${i}`, avatarUrl: "" }, 0);
    // Registering: nobody, not even an outside admin.
    expect(t.canSeeAllCards(admin)).toBe(false);
    t.tick(1000);
    expect(t.meta.status).toBe("running");
    expect(t.canSeeAllCards(admin)).toBe(true);
    expect(t.canSeeAllCards({ id: ADMIN, isAdmin: false })).toBe(false);
    // An admin who is seated, waiting for their next table, or asked to join can't.
    expect(t.canSeeAllCards({ id: 1, isAdmin: true })).toBe(false);
    const e = t.meta.entrants[2]!;
    e.tableId = null;
    e.advancedTo = 99;
    expect(t.canSeeAllCards({ id: 2, isAdmin: true })).toBe(false);
    t.meta.pending = { [ADMIN]: { userId: ADMIN, username: "a", avatarUrl: "", requestedAt: 0 } as never };
    expect(t.canSeeAllCards(admin)).toBe(false);
    delete t.meta.pending[ADMIN];
    // Knocked out: they're a spectator like any other admin.
    e.place = 7;
    expect(t.canSeeAllCards({ id: 2, isAdmin: true })).toBe(true);
    t.meta.status = "finished";
    expect(t.canSeeAllCards(admin)).toBe(false);
  });

  it("returns nothing for anyone who isn't allowed it", () => {
    const { t, tb } = startTable(6);
    expect(t.hostView(tb.id, { id: 1, isAdmin: true }, 0)).toBeNull();
    expect(t.hostView(tb.id, { id: ADMIN, isAdmin: false }, 0)).toBeNull();
    expect(t.hostView(tb.id, admin, 0)).not.toBeNull();
  });

  it("shows every dealt hand, folded ones too, with no actions and no seat", () => {
    const { t, tb } = startTable(3);
    const folder = actor(tb);
    t.act(folder, { type: "fold" }, 1);
    const view = t.hostView(tb.id, admin, 1)!;
    expect(view.hostView).toBe(true);
    expect(view.legal).toBeNull();
    expect(view.mySeat).toBeNull();
    for (const seat of view.seats) if (seat) expect(seat.holeCards).toEqual(cardsOf(tb, seat.userId));
    // Everyone else's view is unchanged.
    expect(t.tableView(tb.id, null, 1)!.hostView).toBe(false);
    expect(t.tableView(tb.id, null, 1)!.seats.find((s) => s?.userId === folder)!.holeCards).toEqual([]);
  });

  it("never sends the deck or undealt cards", () => {
    const { t, tb } = startTable(6);
    const h = tb.hand!;
    const json = JSON.stringify(t.hostView(tb.id, admin, 0));
    expect(json).not.toMatch(/"deck"/);
    for (const card of h.deck.slice(h.deckPos)) expect(json).not.toContain(`"${card}"`);
  });
});
