// What each person at (or watching) a table is sent: nobody may see cards they shouldn't.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/shared/engine/evaluator.ts";
import { defaultConfig } from "../src/server/tournament/structure.ts";
import { RABBIT_MS, Tournament, UNCONTESTED_MS, noopHooks } from "../src/server/tournament/tournament.ts";
import type { TableState, TournamentConfig } from "../src/server/tournament/types.ts";

const HIDDEN = "??";

function startTable(players: number, overrides: Partial<TournamentConfig> = {}) {
  const t = Tournament.create(1, defaultConfig({ startTime: 0, ...overrides }), 0, { ...noopHooks });
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

  it("keeps showing a folded player their own cards, but nobody else", () => {
    const { t, tb } = startTable(3);
    const who = actor(tb);
    t.act(who, { type: "fold" }, 1);
    for (const viewer of [null, 1, 2, 3]) {
      const seat = t.tableView(tb.id, viewer, 1)!.seats.find((s) => s?.userId === who)!;
      expect(seat.holeCards).toEqual(viewer === who ? cardsOf(tb, who) : []);
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

describe("rabbit hunt", () => {
  /** Three players: the first two to act fold, so the big blind wins without a showdown. */
  function foldedToBigBlind(overrides: Partial<TournamentConfig> = {}) {
    const { t, tb } = startTable(3, overrides);
    const folders = [actor(tb)];
    t.act(folders[0]!, { type: "fold" }, 1);
    folders.push(actor(tb));
    t.act(folders[1]!, { type: "fold" }, 2);
    expect(tb.hand!.street).toBe("complete");
    const winner = Number(tb.hand!.players.find((p) => !p.folded)!.playerId);
    return { t, tb, folders, winner };
  }

  it("sends the rest of the board to everyone once the hand is over, and not before", () => {
    const { t, tb } = startTable(3);
    const h = tb.hand!;
    // After the hole cards: burn, flop, burn, turn, burn, river.
    const at = (k: number) => h.deck[h.deckPos + k]!;
    const expected = [at(1), at(2), at(3), at(5), at(7)];
    for (const viewer of [null, 1, 2, 3]) expect(t.tableView(tb.id, viewer, 0)!.rabbit).toEqual([]);
    t.act(actor(tb), { type: "fold" }, 1);
    for (const viewer of [null, 1, 2, 3]) expect(t.tableView(tb.id, viewer, 1)!.rabbit).toEqual([]);
    t.act(actor(tb), { type: "fold" }, 2);
    for (const viewer of [null, 1, 2, 3]) expect(t.tableView(tb.id, viewer, 2)!.rabbit).toEqual(expected);
    expect(t.hostView(tb.id, { id: 99, isAdmin: true }, 2)!.rabbit).toEqual(expected);
  });

  it("gives only the folders a verdict, none without a showdown, and never the winner's cards", () => {
    const { t, tb, folders, winner } = foldedToBigBlind();
    for (const f of folders) {
      const v = t.tableView(tb.id, f, 2)!;
      expect(v.myRabbit).toMatchObject({ outcome: null });
      expect(v.seats.find((s) => s?.userId === f)!.holeCards).toEqual(cardsOf(tb, f));
      const json = JSON.stringify(v);
      for (const card of cardsOf(tb, winner)) expect(json).not.toContain(`"${card}"`);
    }
    expect(t.tableView(tb.id, winner, 2)!.myRabbit).toBeNull();
    expect(t.tableView(tb.id, null, 2)!.myRabbit).toBeNull();
  });

  it("judges a folder against the hands shown at showdown", () => {
    const { t, tb } = startTable(3);
    const folder = actor(tb);
    t.act(folder, { type: "fold" }, 1);
    let now = 2;
    while (tb.hand!.street !== "complete") {
      const who = actor(tb);
      const l = t.tableView(tb.id, who, now)!.legal!;
      t.act(who, l.canCheck ? { type: "check" } : { type: "call" }, now++);
    }
    const board = tb.hand!.board;
    const score = (id: number) => evaluate([...cardsOf(tb, id), ...board]).score;
    const best = Math.max(...tb.hand!.players.filter((p) => !p.folded).map((p) => score(Number(p.playerId))));
    const outcome = score(folder) > best ? "win" : score(folder) === best ? "tie" : "lose";
    const view = t.tableView(tb.id, folder, now)!;
    expect(view.rabbit).toEqual([]); // the board was dealt out for real
    expect(view.myRabbit).toMatchObject({ outcome });
  });

  it("keeps an uncontested hand on screen a little longer while its rabbit cards show", () => {
    expect(foldedToBigBlind().tb.handDoneAt).toBe(2 + RABBIT_MS);
  });

  it("can be switched off", () => {
    const { t, tb, folders } = foldedToBigBlind({ rabbitHunt: false });
    expect(tb.handDoneAt).toBe(2 + UNCONTESTED_MS);
    for (const viewer of [null, ...folders]) {
      const v = t.tableView(tb.id, viewer, 2)!;
      expect(v.rabbit).toEqual([]);
      expect(v.myRabbit).toBeNull();
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
