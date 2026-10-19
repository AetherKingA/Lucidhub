// Load test / practice opponents: connects fake players that register for a tournament and play
// moves, exactly like real browsers would (same WebSocket, same messages).
//
//   node scripts/bots.ts <count> [tournamentId] [--fast]
//
// Without a tournament id, bots join the first tournament that's open for registration.
// --fast makes bots move almost instantly (for load testing) instead of thinking for 0.5-3 s.
// Bots prefer captures and checks, otherwise move at random; now and then they offer a draw and
// accept about half the offers they get. Bot accounts are created in the local database with
// Discord IDs starting at 900000000000000001.

import { createHash, randomBytes } from "node:crypto";
import WebSocket from "ws";
import { createSession, upsertUser } from "../src/server/db.ts";
import { config } from "../src/server/config.ts";
import type { ClientAction, ServerMessage, TableView } from "../src/shared/protocol.ts";

const args = process.argv.slice(2);
const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 10);
const wantedId = Number(args.filter((a) => /^\d+$/.test(a))[1] ?? 0) || null;
const fast = args.includes("--fast");
const url = `ws://localhost:${config.port}/ws`;

let connected = 0;
let actions = 0;
let errors = 0;
let latencyTotal = 0;
let latencyCount = 0;

function makeSession(n: number) {
  const user = upsertUser(String(900000000000000000n + BigInt(n)), `Bot ${n}`, null);
  const token = randomBytes(32).toString("base64url");
  createSession(createHash("sha256").update(token).digest("hex"), user.id, Date.now() + 86_400_000);
  return token;
}

function startBot(n: number, token = makeSession(n)) {
  const ws = new WebSocket(url, { headers: { Cookie: `sid=${token}` } });
  let registered = false;
  // Per board, so a bot playing in two tournaments at once doesn't cancel its own moves.
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const actedFor = new Map<string, string>();
  const answeredOffer = new Map<string, string>();
  let sentAt = 0;

  let opened = false;
  ws.on("open", () => {
    opened = true;
    connected++;
  });
  ws.on("close", () => {
    if (opened) connected--;
    for (const t of pending.values()) clearTimeout(t);
    // Reconnect like a browser would (e.g. after the server restarts).
    setTimeout(() => startBot(n, token), 1000 + Math.random() * 3000);
  });
  ws.on("error", () => errors++);
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as ServerMessage;
    if (msg.type === "lobby" && !registered) {
      const t = msg.tournaments.find((x) => (wantedId ? x.id === wantedId : x.registrationOpen) && x.registrationOpen);
      if (t && !t.me?.registered) {
        ws.send(JSON.stringify({ type: "register", tournamentId: t.id }));
        registered = true;
      } else if (t?.me?.registered) registered = true;
    } else if (msg.type === "table") {
      if (sentAt && !msg.view.legal.length) {
        latencyTotal += Date.now() - sentAt;
        latencyCount++;
        sentAt = 0;
      }
      maybeAct(msg.view);
    } else if (msg.type === "error") {
      errors++;
    }
  });

  const send = (view: TableView, action: ClientAction) => ws.send(JSON.stringify({ type: "action", tournamentId: view.tournamentId, action }));

  function maybeAct(view: TableView) {
    if (view.mySeat === null || view.result) return;
    const board = `${view.tournamentId}:${view.tableId}`;
    // Answer a draw offer once.
    const offerKey = `${view.gameNo}:${view.moves.length}`;
    if (view.drawOfferSeat !== null && view.drawOfferSeat !== view.mySeat && answeredOffer.get(board) !== offerKey) {
      answeredOffer.set(board, offerKey);
      setTimeout(() => send(view, { type: Math.random() < 0.5 ? "draw" : "declineDraw" }), fast ? 30 : 800);
    }
    if (!view.legal.length) return;
    // One decision per turn.
    const turn = `${view.gameNo}:${view.moves.length}`;
    if (actedFor.get(board) === turn) return;
    actedFor.set(board, turn);
    clearTimeout(pending.get(board));
    pending.set(board, setTimeout(
      () => {
        if (view.moves.length > 40 && view.drawOfferSeat === null && Math.random() < 0.02) send(view, { type: "draw" });
        sentAt = Date.now();
        send(view, { type: "move", uci: choose(view) });
        actions++;
      },
      fast ? 20 + Math.random() * 80 : 500 + Math.random() * 2500,
    ));
  }
}

/** Takes something if it can (biggest piece first), promotes to a queen, otherwise moves at random. */
function choose(view: TableView): string {
  const value: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const files = "abcdefgh";
  const sq = (s: string) => files.indexOf(s[0]!) + (Number(s[1]) - 1) * 8;
  const score = (u: string) => {
    const target = view.board[sq(u.slice(2, 4))] ?? "";
    return (target ? value[target.toLowerCase()]! * 10 : 0) + (u.endsWith("q") ? 80 : 0) + Math.random() * 6;
  };
  return [...view.legal].sort((a, b) => score(b) - score(a))[0]!;
}

console.log(`Starting ${count} bots against ${url}${wantedId ? ` (tournament ${wantedId})` : ""}...`);
for (let i = 1; i <= count; i++) {
  startBot(i);
  if (i % 100 === 0) await new Promise((r) => setTimeout(r, 200)); // don't open 1000 sockets in one burst
}

setInterval(() => {
  const avg = latencyCount ? Math.round(latencyTotal / latencyCount) : 0;
  console.log(`[bots] connected ${connected}/${count} · moves ${actions} · server round-trip ~${avg} ms · errors ${errors}`);
  latencyTotal = latencyCount = 0;
}, 5000);
