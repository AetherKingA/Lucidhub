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
