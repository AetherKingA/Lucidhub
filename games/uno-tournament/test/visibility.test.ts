// Nobody may ever be sent another player's cards or the order of the draw pile. Plays whole tables
// and checks every view the server would send, to every player and to spectators, after every move.

import { describe, expect, it } from "vitest";
import { nextRandom } from "../src/shared/engine/cards.ts";
import { autoAction, current } from "../src/shared/engine/game.ts";
import type { ClientAction, TableView } from "../src/shared/protocol.ts";
import { defaultConfig } from "../src/server/tournament/structure.ts";
import { Tournament } from "../src/server/tournament/tournament.ts";

const T0 = 1_000_000;

function checkView(view: TableView, t: Tournament, viewerId: number | null) {
  const table = t.tables.get(view.tableId)!;
  const g = table.game;
  // Only these fields may carry cards: your own hand, the top of the discards, and what you may play.
  const own = g?.players.find((p) => p.playerId === String(viewerId));
  expect([...view.myHand].sort()).toEqual(own ? [...own.hand].sort() : []);
  for (const c of view.legal?.playable ?? []) expect(own!.hand).toContain(c);
  if (view.legal?.drawn) expect(own!.hand).toContain(view.legal.drawn);
  if (g) expect(view.topCard).toBe(g.discard[g.discard.length - 1]);

  // Nothing else in the view may look like a hand or the pile.
  const json = JSON.stringify({ ...view, myHand: undefined, legal: undefined, topCard: undefined });
  expect(json).not.toMatch(/"(hand|drawPile|discard|rng)"/);
  expect(json).not.toMatch(/"(?:[rygb](?:\d|S|R|D)|W4?)"/);
  for (const s of view.seats) if (s) expect(Object.keys(s).some((k) => /card(?!Count)/i.test(k))).toBe(false);
}

describe("visibility", () => {
  it("each player sees only their own cards; spectators see none", () => {
    const s = { rng: 7 };
    const t = Tournament.create(1, { ...defaultConfig(), startTime: T0, tableSize: 4, winsToAdvance: 2, stacking: true }, T0, undefined, () => nextRandom(s));
    for (let i = 1; i <= 8; i++) t.register({ id: i, username: `P${i}`, avatarUrl: "" }, T0);
    t.start(T0);
    let now = T0;
    let checked = 0;
    for (let step = 0; step < 3000 && t.meta.status === "running"; step++) {
      for (const table of [...t.tables.values()]) {
        for (const viewer of [null, ...table.seats.flatMap((x) => (x ? [x.userId] : []))]) {
          const view = t.tableView(table.id, viewer, now)!;
          checkView(view, t, viewer);
          checked++;
        }
        const g = table.game;
        if (g && !g.winner) t.act(Number(current(g).playerId), autoAction(g) as ClientAction, now);
      }
      now += 1000;
      t.tick(now);
    }
    expect(checked).toBeGreaterThan(500);
  });
});

describe("host view (admins who aren't playing see every hand)", () => {
  const ADMIN = 99;
  const admin = { id: ADMIN, isAdmin: true };

  function running() {
    const s = { rng: 3 };
    const t = Tournament.create(1, { ...defaultConfig(), startTime: T0, tableSize: 4, winsToAdvance: 2, stacking: true }, T0, undefined, () => nextRandom(s));
    for (let i = 1; i <= 8; i++) t.register({ id: i, username: `P${i}`, avatarUrl: "" }, T0);
    return t;
  }

  it("is only for admins with no stake in the tournament, and only while it runs", () => {
    const t = running();
    expect(t.canSeeAllCards(admin)).toBe(false);
    t.start(T0);
    expect(t.canSeeAllCards(admin)).toBe(true);
    expect(t.canSeeAllCards({ id: ADMIN, isAdmin: false })).toBe(false);
    // Seated, waiting for a next table, or asked to join: no.
    expect(t.canSeeAllCards({ id: 1, isAdmin: true })).toBe(false);
    const e = t.meta.entrants[2]!;
    e.tableId = null;
    e.advancedTo = 99;
    expect(t.canSeeAllCards({ id: 2, isAdmin: true })).toBe(false);
    t.meta.pending = { [ADMIN]: { userId: ADMIN } as never };
    expect(t.canSeeAllCards(admin)).toBe(false);
    delete t.meta.pending[ADMIN];
    // Knocked out: like any other admin.
    e.place = 8;
    expect(t.canSeeAllCards({ id: 2, isAdmin: true })).toBe(true);
    t.meta.status = "finished";
    expect(t.canSeeAllCards(admin)).toBe(false);
  });

  it("shows every player's hand to the host only, with no actions, and never the draw pile", () => {
    const t = running();
    t.start(T0);
    const table = [...t.tables.values()][0]!;
    let now = T0;
    while (!table.game && now < T0 + 60_000) t.tick((now += 500));
    const g = table.game!;
    const seated = table.seats.find((s) => s)!.userId;
    expect(t.hostView(table.id, { id: seated, isAdmin: true }, now)).toBeNull();
    expect(t.hostView(table.id, { id: ADMIN, isAdmin: false }, now)).toBeNull();
    const view = t.hostView(table.id, admin, now)!;
    expect(view.hostView).toBe(true);
    expect(view.legal).toBeNull();
    expect(view.mySeat).toBeNull();
    expect(view.myHand).toEqual([]);
    expect(view.canCallUno).toBe(false);
    for (const p of g.players) expect([...view.seats[p.seat]!.hand!].sort()).toEqual([...p.hand].sort());
    expect(JSON.stringify(view)).not.toMatch(/"(drawPile|discard|rng)"/);
    // Everyone else's view is unchanged.
    const spectator = t.tableView(table.id, null, now)!;
    expect(spectator.hostView).toBe(false);
    for (const s of spectator.seats) if (s) expect(s.hand).toBeUndefined();
  });
});
