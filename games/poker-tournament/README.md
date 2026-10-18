# Poker Night

Free play-money No-Limit Hold'em tournaments with Discord sign-in. This folder is only the poker
game. **LucidHub** (two folders up) runs it: it starts the server, hands it its settings, opens it to
players through Tailscale Funnel, and pays out Discord prizes when a tournament ends. Setup is in
LucidHub's `SETUP.md`.

## Running a tournament

Sign in with a Discord account listed in LucidHub's `ADMIN_DISCORD_IDS`. You'll see an **Admin** badge.
You can also create and control tournaments from LucidHub's **Events** page.

- **Format:** every tournament is a 6-max **shootout**. Each table plays until one player has all the
  chips, and that winner advances. The winners of every six tables meet at a new table, where everyone
  starts again with the same stack and the blinds back at level 1, so nobody can bully a new table
  with chips won earlier. This repeats until the final table. Player caps are 6, 36, 216 or 1,296
  (one to four rounds), so the bracket always collapses evenly. A group of six tables moves on as soon
  as all six are done; it doesn't wait for the rest of the round.
- **Create:** click **+ New tournament** in the lobby and pick a start time, cap and structure. It
  starts automatically at that time if at least two players have registered (registration closes
  then). You can also open the tournament and use **Admin → Start now**.
- **Pause / resume:** Admin tab on the tournament page. Pausing freezes the blind clock and every
  player's timer; hands continue exactly where they stopped.
- **Shared-IP flags:** the Admin tab lists players at the same table who have signed in from the same
  IP address, with a button to remove a player.
- **If the server stops mid-tournament** (LucidHub stopped it, the PC crashed or lost power), the
  tournament comes back **paused** at the moment it stopped, mid-hand, with everyone's chips.
  Players' browsers reconnect by themselves. Click **Resume** when you're ready.
- **"Your Discord account needs a verified email":** that player has to verify their email in
  Discord's settings first. This is the anti-multi-account check.

## Settings it receives from LucidHub

| Variable | Meaning |
| --- | --- |
| `PORT` | Where it listens on this PC (from the game's address in LucidHub, default 3000). |
| `PUBLIC_URL` | Where players reach it (the Funnel address). Discord redirects back here. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Player sign-in, using LucidHub's Discord application. |
| `ADMIN_DISCORD_IDS` | Who gets admin tools. |
| `HUB_URL`, `HUB_SECRET` | The signed connection to LucidHub (INTEGRATION.md in the hub). |
| `DB_PATH` | `event-hub/data/games/poker/poker.db`, so all data sits in the hub's data folder. |

Optional: `SESSION_DAYS` (default 30), `TRUST_PROXY` (default true; Funnel forwards the real IP).
When it runs on its own for development, it reads the same names from a `.env` in this folder.

## Integration with LucidHub

Everything under `/api/integration` is signed with `HUB_SECRET` (`X-Hub-Timestamp` +
`X-Hub-Signature` = HMAC-SHA256 of `timestamp.body`, five-minute window): `GET /info`,
`POST /events`, `GET /events?status=&since=`, `POST /events/:id/start|pause|resume|cancel`,
`GET /events/:id/results`, and `POST /shutdown` (saves everything, then exits; how LucidHub stops it).
When a tournament finishes it POSTs `{"type":"event.finished"}` to `HUB_URL/api/games/poker/webhook`;
if LucidHub is down, it picks the result up on its next poll.

## Testing without Discord

```
npm run dev-login -w games/poker-tournament -- "Your Name"
```

prints a `sid=...` line. Open http://localhost:3000, press F12, and in the Console run
`document.cookie = "sid=...; path=/"` with that value, then reload. To make that test account an
admin, add `800000000000000001` to `ADMIN_DISCORD_IDS` in LucidHub's `.env` and restart Poker Night.

Bots give you opponents and double as a load test (they connect and play exactly like browsers):

```
npm run bots -w games/poker-tournament -- 50            # 50 bots join the first open tournament
npm run bots -w games/poker-tournament -- 1000 2 --fast # 1000 instant-acting bots join tournament #2
```

Stop them with Ctrl+C. Bot accounts are real rows in the database named "Bot 1", "Bot 2", and so on,
so don't run them against a real event.

## Development

Run these from the `event-hub` folder (one `npm install` there covers every game):

```
npm run dev -w games/poker-tournament    # server + live-reloading site at http://localhost:5173
npm test -w games/poker-tournament       # engine and tournament tests, including full simulations
```

`test/visibility.test.ts` checks that nobody is sent cards they shouldn't see, and
`scripts/visibility-check.ts` checks the same thing against a running server over the real WebSocket
(see the comment at its top; it creates test accounts, so not against a real event).
