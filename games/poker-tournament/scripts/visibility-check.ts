// Black-box check of what a running server sends: connects players and a spectator over the real
// WebSocket, plays some hands, and fails if any frame shows someone cards they shouldn't see.
//
//   node --env-file=<same .env as the server> scripts/visibility-check.ts [seconds]
//
// Needs HUB_SECRET set (it creates its own tournament through the signed hub API). Creates test
// accounts with Discord IDs 9100…; don't run it against a real event.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { config } from "../src/server/config.ts";
import { createSession, upsertUser } from "../src/server/db.ts";
import type { ServerMessage, TableView } from "../src/shared/protocol.ts";

const SECONDS = Number(process.argv[2] ?? 40);
const PLAYERS = 4;
const base = `http://127.0.0.1:${config.port}`;
const CARD = /"[2-9TJQKA][cdhs]"/g;

function session(n: number) {
  const user = upsertUser(String(9100000000000000000n + BigInt(n)), `Check ${n}`, null);
  const token = randomBytes(32).toString("base64url");
  createSession(createHash("sha256").update(token).digest("hex"), user.id, Date.now() + 3_600_000);
  return { userId: user.id, token };
}

async function createTournament() {
  const body = JSON.stringify({ name: "Visibility check", startTime: Date.now() + 4000, maxPlayers: 6, levelMinutes: 1, decisionSeconds: 5 });
  const ts = String(Date.now());
  const sig = createHmac("sha256", config.hub.secret).update(`${ts}.${body}`).digest("hex");
  const res = await fetch(`${base}/api/integration/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-timestamp": ts, "x-hub-signature": sig },
    body,
  });
  if (!res.ok) throw new Error(`Creating the tournament failed: ${res.status} ${await res.text()}`);
  return Number(((await res.json()) as { id: string }).id);
}

interface Watcher {
  name: string;
  userId: number | null;
  frames: number;
  tableFrames: number;
  leaks: string[];
  showdownsSeen: number;
  /** Table views where the viewer's own cards were visible (proves the check sees real cards). */
  ownCardViews: number;
}

function inspect(w: Watcher, raw: string) {
  w.frames++;
  if (raw.includes('"deck"')) w.leaks.push(`frame mentions "deck": ${raw.slice(0, 200)}`);
  const msg = JSON.parse(raw) as ServerMessage;
  if (msg.type !== "table") {
    // No other message type should ever carry a card.
    if (CARD.test(raw)) w.leaks.push(`${msg.type} message contains a card: ${raw.slice(0, 200)}`);
    CARD.lastIndex = 0;
    return;
  }
  w.tableFrames++;
  const v: TableView = msg.view;
  const complete = v.street === "complete";
  const allowed = new Set(v.board);
  let revealedOthers = 0;
  for (const s of v.seats) {
    if (!s) continue;
    const real = s.holeCards.filter((c) => c !== "??");
    if (s.userId === w.userId) {
      if (real.length) w.ownCardViews++;
      real.forEach((c) => allowed.add(c));
      continue;
    }
    if (real.length) {
      if (!complete) w.leaks.push(`${w.name} saw ${s.username}'s cards ${real.join(" ")} during ${v.street}`);
      else if (!s.handName) w.leaks.push(`${w.name} saw ${s.username}'s cards at the end without a showdown`);
      else revealedOthers++;
      real.forEach((c) => allowed.add(c));
    }
  }
  if (revealedOthers) w.showdownsSeen++;
  // Every card anywhere in the frame must be the viewer's own, on the board, or revealed at showdown.
  for (const m of raw.match(CARD) ?? []) {
    const c = m.slice(1, -1);
    if (!allowed.has(c)) w.leaks.push(`${w.name} got unexplained card ${c} (street ${v.street})`);
  }
}

const tournamentId = await createTournament();
const players = Array.from({ length: PLAYERS }, (_, i) => ({ ...session(i + 1), n: i + 1 }));
const specSession = session(99);
const watchers: Watcher[] = [];
const sockets: WebSocket[] = [];

function connect(name: string, token: string, userId: number | null, onMsg: (ws: WebSocket, m: ServerMessage) => void) {
  const w: Watcher = { name, userId, frames: 0, tableFrames: 0, leaks: [], showdownsSeen: 0, ownCardViews: 0 };
  watchers.push(w);
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}/ws`, { headers: { cookie: `sid=${token}` } });
  sockets.push(ws);
  ws.on("message", (data) => {
    const raw = String(data);
    inspect(w, raw);
    onMsg(ws, JSON.parse(raw) as ServerMessage);
  });
  return ws;
}

for (const p of players) {
  const ws = connect(`Player ${p.n}`, p.token, p.userId, (sock, m) => {
    // Call or check whenever it's our turn, so hands reach showdown.
    if (m.type === "table" && m.view.legal) {
      const a = m.view.legal.canCheck ? { type: "check" } : { type: "call" };
      setTimeout(() => sock.send(JSON.stringify({ type: "action", tournamentId, action: a })), 50);
    }
  });
  ws.on("open", () => ws.send(JSON.stringify({ type: "register", tournamentId })));
}

// The spectator isn't registered; once the table exists, it watches it.
let watching = false;
const spec = connect("Spectator", specSession.token, specSession.userId, (sock, m) => {
  if (watching || m.type !== "lobby") return;
  const t = m.tournaments.find((x) => x.id === tournamentId);
  if (t?.status === "running") {
    watching = true;
    sock.send(JSON.stringify({ type: "watch", tournamentId, tableId: 1 }));
  }
});
void spec;

await new Promise((r) => setTimeout(r, SECONDS * 1000));
for (const s of sockets) s.close();

let failed = false;
for (const w of watchers) {
  console.log(
    `${w.name.padEnd(10)} ${String(w.frames).padStart(5)} frames, ${String(w.tableFrames).padStart(4)} table views, own cards visible in ${w.ownCardViews}, showdowns seen: ${w.showdownsSeen}, leaks: ${w.leaks.length}`,
  );
  if (w.userId !== null && w.name !== "Spectator" && w.ownCardViews === 0) {
    console.log(`   ${w.name} never saw its own cards, so this check proves nothing for it.`);
    failed = true;
  }
  for (const l of w.leaks.slice(0, 5)) console.log(`   LEAK: ${l}`);
  if (w.leaks.length) failed = true;
}
console.log(failed ? "\nFAILED: some frames showed cards they shouldn't." : "\nOK: nobody received another player's cards before showdown, and no frame contained the deck.");
process.exit(failed ? 1 : 0);
