# Uno Night

Free Uno tournaments with Discord sign-in. This folder is only the Uno game. **LucidHub** (two folders
up) runs it: it starts the server, hands it its settings, opens it to players through Tailscale Funnel,
and pays out Discord prizes when a tournament ends. Setup is in LucidHub's `SETUP.md`.

## Running a tournament

Sign in with a Discord account listed in LucidHub's `ADMIN_DISCORD_IDS`. You'll see an **Admin** badge.
You can also create and control tournaments from LucidHub's **Events** page.

- **Format:** a bracket. Players are drawn to tables of 3–6 (you choose). Each table plays hands until
  someone has won the set number (1, 2 or 3); that player wins the table and goes through, everyone
  else at the table is out. The winners of every group of tables meet at a new table, back on zero
  wins. This repeats until the final table. A group moves on as soon as all its tables are done; it
  doesn't wait for the rest of the round.
- **Places:** going out in a later round always beats an earlier one. Players knocked out at the same
  table are ranked by hands won, then by fewest card points left over from the hands they lost
  (number cards count their value, action cards 20, wilds 50).
- **Rules:** official Uno. Match by color or value, or play a Wild. Wild Draw Four only when you have no
  card of the current color. Can't play: draw one, and play it straight away if it fits. Forget to call
  UNO and anyone can catch you before the next player moves: you draw two.
- **Stacking +2/+4** (set when creating the tournament): a player hit by Draw Two can pass it on with
  another Draw Two or a Wild Draw Four, and Wild Draw Four with another Wild Draw Four. Whoever finally
  draws takes the total and misses their turn.
- **Timer:** each turn has a decision time plus a time bank per table. Run out and the game plays for
  you (a matching card if there is one, otherwise it draws) until you click **I'm back**.
- **Create:** click **+ New tournament** in the lobby. It starts automatically at its start time if at
  least two players have registered (registration closes then), or use **Admin → Start now**.
- **Pause / resume:** Admin tab on the tournament page. Pausing freezes every player's timer.
- **Shared-IP flags:** the Admin tab lists players at the same table who have signed in from the same
  IP address, with a button to remove a player (they take the worst place still open in their round).
- **If the server stops mid-tournament,** the tournament comes back **paused**, mid-hand, with everyone's
  cards. Players' browsers reconnect by themselves. Click **Resume** when you're ready.

## Settings it receives from LucidHub

| Variable | Meaning |
| --- | --- |
| `PORT` | Where it listens on this PC (from the game's address in LucidHub, default 3001). |
| `PUBLIC_URL` | Where players reach it (the Funnel address). Discord redirects back here. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Player sign-in, using LucidHub's Discord application. |
| `ADMIN_DISCORD_IDS` | Who gets admin tools. |
| `HUB_URL`, `HUB_SECRET` | The signed connection to LucidHub (INTEGRATION.md in the hub). |
| `DB_PATH` | `event-hub/data/games/uno/uno.db`, so all data sits in the hub's data folder. |

Optional: `SESSION_DAYS` (default 30), `TRUST_PROXY` (default true; Funnel forwards the real IP).
When it runs on its own for development, it reads the same names from a `.env` in this folder.

## Integration with LucidHub

Everything under `/api/integration` is signed with `HUB_SECRET`, exactly as Poker Night does it:
`GET /info`, `POST /events`, `GET /events?status=&since=`, `POST /events/:id/start|pause|resume|cancel`,
`GET /events/:id/results`, and `POST /shutdown`. The New Event form in LucidHub offers: name, start
time, player cap, players per table, hands to win a table, stacking, decision time and time bank. When a
tournament finishes it POSTs `{"type":"event.finished"}` to `HUB_URL/api/games/uno/webhook`.

## Testing without Discord

```
npm run dev-login -w games/uno-tournament -- "Your Name"
```

prints a `sid=...` line. Open http://localhost:3001, press F12, and in the Console run
`document.cookie = "sid=...; path=/"` with that value, then reload. To make that test account an
admin, add `800000000000000001` to `ADMIN_DISCORD_IDS` in LucidHub's `.env` and restart Uno Night.

Bots give you opponents and double as a load test (they connect and play exactly like browsers; they
forget UNO now and then and catch each other):

```
npm run bots -w games/uno-tournament -- 11            # 11 bots join the first open tournament
npm run bots -w games/uno-tournament -- 500 2 --fast  # 500 instant-acting bots join tournament #2
```

Stop them with Ctrl+C. Bot accounts are real rows in the database named "Bot 1", "Bot 2", and so on,
so don't run them against a real event.

## Development

Run these from the `event-hub` folder (one `npm install` there covers every game):

```
npm run dev -w games/uno-tournament    # server + live-reloading site at http://localhost:5175
npm test -w games/uno-tournament       # rules engine, tournament simulations, visibility, hub API
```

The rules engine is `src/shared/engine/game.ts`: a pure state machine with a seeded shuffle, so a
saved game continues exactly where it stopped. `test/visibility.test.ts` checks that nobody is ever
sent another player's cards or the draw pile.
