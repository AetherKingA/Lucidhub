// Fake players for testing: they join a tournament and keep flying (with an imperfect autopilot)
// until the clock runs out, so the ghost race has plenty of birds.
//
//   node scripts/bots.ts <tournamentId> [count] [server, default http://localhost:3003]

import { createHash, randomBytes } from "node:crypto";
import WebSocket from "ws";
import { TICK_MS, autopilot, simulate } from "../src/shared/engine/flappy.ts";
import type { ServerMessage, TournamentView } from "../src/shared/protocol.ts";
import { createSession, upsertUser } from "../src/server/db.ts";

const tournamentId = Number(process.argv[2]);
const count = Number(process.argv[3] ?? 5);
const server = (process.argv[4] ?? "http://localhost:3003").replace(/^http/, "ws");
if (!Number.isInteger(tournamentId)) {
  console.log("Usage: node scripts/bots.ts <tournamentId> [count] [server]");
  process.exit(1);
}

const NAMES = ["Pidge", "Tweety", "Flapjack", "Wingnut", "Featherstone", "Beaky", "Skye", "Goose", "Robin", "Nugget"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bot(i: number) {
  const name = `${NAMES[i % NAMES.length]} (bot)`;
  const user = upsertUser(`80000000000000${String(1000 + i)}`, name, null);
  const token = randomBytes(32).toString("base64url");
  createSession(createHash("sha256").update(token).digest("hex"), user.id, Date.now() + 86_400_000);
  const skill = 0.55 + Math.random() * 0.4;

  const ws = new WebSocket(`${server}/ws`, { headers: { cookie: `sid=${token}` } });
  let view: TournamentView | null = null;
  let flying = false;
  const send = (m: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));

  ws.on("open", () => {
    send({ type: "open", tournamentId });
    send({ type: "register", tournamentId });
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as ServerMessage;
    if (msg.type === "tournament") {
      view = msg.view;
      if (!flying && view.status === "running" && !view.paused && view.seed !== null) void flyLoop();
    }
    if (msg.type === "runSaved") console.log(`${name}: ${msg.score} pipes${msg.newBest ? " (new best)" : ""}`);
    if (msg.type === "error" && !/already registered/.test(msg.message)) console.log(`${name}: ${msg.message}`);
  });
  ws.on("close", () => console.log(`${name}: disconnected`));

  async function flyLoop() {
    flying = true;
    while (view && view.status === "running" && !view.paused && view.seed !== null) {
      const seed = view.seed;
      const flaps = autopilot(seed, 20_000, skill);
      const length = simulate(seed, flaps).distance;
      send({ type: "runStart", tournamentId });
      // Fly in real time, or until the clock runs out.
      const until = Math.min(Date.now() + length * TICK_MS, view.endsAt ?? Infinity);
      await sleep(Math.max(0, until - Date.now()));
      send({ type: "runEnd", tournamentId, flaps });
      await sleep(800 + Math.random() * 1500);
    }
    flying = false;
  }
}

for (let i = 0; i < count; i++) bot(i);
console.log(`${count} bots joining tournament ${tournamentId} on ${server}. Ctrl+C to stop.`);
