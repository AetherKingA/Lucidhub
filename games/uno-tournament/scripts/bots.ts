// Load test / practice opponents: connects fake players that register for a tournament and play
// simple moves, exactly like real browsers would (same WebSocket, same messages).
//
//   node scripts/bots.ts <count> [tournamentId] [--fast]
//
// Without a tournament id, bots join the first tournament that's open for registration.
// --fast makes bots act almost instantly (for load testing) instead of thinking for 0.5-2.5 s.
// Bots call UNO most of the time (not always, so catching gets tested) and sometimes catch each other.
// Bot accounts are created in the local database with Discord IDs starting at 900000000000000001.

import { createHash, randomBytes } from "node:crypto";
import WebSocket from "ws";
import { createSession, upsertUser } from "../src/server/db.ts";
import { config } from "../src/server/config.ts";
import { COLORS, colorOf, isWild, valueOf } from "../src/shared/engine/cards.ts";
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
  let pending: ReturnType<typeof setTimeout> | null = null;
  let actedFor = "";
  let sentAt = 0;

  let opened = false;
  ws.on("open", () => {
    opened = true;
    connected++;
  });
  ws.on("close", () => {
    if (opened) connected--;
    if (pending) clearTimeout(pending);
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
      if (sentAt && msg.view.legal === null) {
        latencyTotal += Date.now() - sentAt;
        latencyCount++;
        sentAt = 0;
      }
      maybeAct(msg.view);
    } else if (msg.type === "error") {
      errors++;
    }
  });

  function maybeAct(view: TableView) {
    const caught = view.seats.find((s) => s?.catchable && s.seat !== view.mySeat);
    if (caught && Math.random() < 0.3) {
      setTimeout(() => ws.send(JSON.stringify({ type: "action", tournamentId: view.tournamentId, action: { type: "catch", seat: caught.seat } })), fast ? 30 : 400);
    }
    const legal = view.legal;
    if (!legal) return;
    // One decision per turn: the hand, what has happened in it so far and the drawn card identify the turn.
    const turn = `${view.tableId}:${view.handNo}:${view.events.join("|")}:${legal.drawn}:${view.myHand.length}`;
    if (turn === actedFor) return;
    actedFor = turn;
    if (pending) clearTimeout(pending);
    pending = setTimeout(
      () => {
        sentAt = Date.now();
        ws.send(JSON.stringify({ type: "action", tournamentId: view.tournamentId, action: choose(view) }));
        actions++;
      },
      fast ? 20 + Math.random() * 80 : 500 + Math.random() * 2000,
    );
  }
}

/** Plays an action card or the color it holds most of, keeps wilds for last, sometimes forgets UNO. */
function choose(view: TableView): ClientAction {
  const legal = view.legal!;
  if (!legal.playable.length) return legal.canPass ? { type: "pass" } : { type: "draw" };
  const counts = new Map<string, number>();
  for (const c of view.myHand) if (colorOf(c)) counts.set(colorOf(c)!, (counts.get(colorOf(c)!) ?? 0) + 1);
  const rank = (c: string) => (isWild(c) ? -100 : (/^\d$/.test(valueOf(c)) ? 0 : 5) + (counts.get(colorOf(c)!) ?? 0) + Math.random());
  const card = [...legal.playable].sort((a, b) => rank(b) - rank(a))[0]!;
  const color = [...COLORS].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))[0]!;
  return { type: "play", card, ...(isWild(card) ? { color } : {}), uno: view.myHand.length === 2 && Math.random() < 0.85 };
}

console.log(`Starting ${count} bots against ${url}${wantedId ? ` (tournament ${wantedId})` : ""}...`);
for (let i = 1; i <= count; i++) {
  startBot(i);
  if (i % 100 === 0) await new Promise((r) => setTimeout(r, 200)); // don't open 1000 sockets in one burst
}

setInterval(() => {
  const avg = latencyCount ? Math.round(latencyTotal / latencyCount) : 0;
  console.log(`[bots] connected ${connected}/${count} · actions ${actions} · server round-trip ~${avg} ms · errors ${errors}`);
  latencyTotal = latencyCount = 0;
}, 5000);
