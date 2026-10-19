# Chess Night

Free knockout chess tournaments with Discord sign-in. This folder is only the chess game. **LucidHub**
(two folders up) runs it: it starts the server, hands it its settings, opens it to players through
Tailscale Funnel, and pays out Discord prizes when a tournament ends. Setup is in LucidHub's `SETUP.md`.

## Running a tournament

Sign in with a Discord account listed in LucidHub's `ADMIN_DISCORD_IDS`. You'll see an **Admin** badge.
You can also create and control tournaments from LucidHub's **Events** page.

- **Format:** the same bracket as Uno Night, with two players per board. Players are drawn into a
  knockout bracket sized to the next power of two; anyone without a round-1 opponent gets a **bye**
  (spread across the bracket). Each board plays a match until someone has won the set number of games
  (1, 2 or 3); the winner goes through to meet the winner of the neighbouring board, the loser is out.
  A match starts as soon as both its players are ready; it doesn't wait for the rest of the round.
- **Colors:** random in game 1, then they swap every game.
- **Draws** don't count; the match goes on. After two draws in a row the next game is **Armageddon**:
  a draw counts as a win for Black, so every match ends.
- **Places:** going out in a later round always beats an earlier one. Within a round, players knocked
  out later rank higher.
- **Clock:** the time control is picked when creating the tournament (1+0 up to 15+10). Clocks start
  after each side's first move; each player has 30 seconds to make that first move or loses the game.
  Running out of time loses, unless the opponent can't possibly checkmate (then it's a draw).
- **Rules:** full chess rules: castling, en passant, promotion (you pick the piece), and automatic draws
  by stalemate, threefold repetition, the fifty-move rule and insufficient material. Players can resign
  and offer draws; an offer stands until the opponent accepts, declines or moves.
- **Create:** click **+ New tournament** in the lobby. It starts automatically at its start time if at
  least two players have registered (registration closes then), or use **Admin → Start now**.
- **Pause / resume:** Admin tab on the tournament page. Pausing freezes every clock.
- **Shared-IP flags:** the Admin tab lists opponents who have signed in from the same IP address, with a
  button to remove a player (their opponent wins the match).
- **If the server stops mid-tournament,** the tournament comes back **paused**, mid-game, with every
  position and clock as they were. Players' browsers reconnect by themselves. Click **Resume** when ready.

## Settings it receives from LucidHub

| Variable | Meaning |
| --- | --- |
| `PORT` | Where it listens on this PC (from the game's address in LucidHub, default 3002). |
| `PUBLIC_URL` | Where players reach it (the Funnel address). Discord redirects back here. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Player sign-in, using LucidHub's Discord application. |
| `ADMIN_DISCORD_IDS` | Who gets admin tools. |
| `HUB_URL`, `HUB_SECRET` | The signed connection to LucidHub (INTEGRATION.md in the hub). |
| `DB_PATH` | `event-hub/data/games/chess/chess.db`, so all data sits in the hub's data folder. |

Optional: `SESSION_DAYS` (default 30), `TRUST_PROXY` (default true; Funnel forwards the real IP).
When it runs on its own for development, it reads the same names from a `.env` in this folder.

## Integration with LucidHub

Everything under `/api/integration` is signed with `HUB_SECRET`, exactly as Poker Night and Uno Night do
it: `GET /info`, `POST /events`, `GET /events?status=&since=`, `POST /events/:id/start|pause|resume|cancel`,
`GET /events/:id/results`, and `POST /shutdown`. The New Event form in LucidHub offers: name, start time,
player cap, games to win a match and time control. When a tournament finishes it POSTs
`{"type":"event.finished"}` to `HUB_URL/api/games/chess/webhook`.

## Testing without Discord

```
npm run dev-login -w games/chess-tournament -- "Your Name"
```

prints a `sid=...` line. Open http://localhost:3002, press F12, and in the Console run
`document.cookie = "sid=...; path=/"` with that value, then reload. To make that test account an
admin, add `800000000000000001` to `ADMIN_DISCORD_IDS` in LucidHub's `.env` and restart Chess Night.

Bots give you opponents and double as a load test (they connect and play exactly like browsers; they
grab material when they can, otherwise move at random, and sometimes offer or accept draws):

```
npm run bots -w games/chess-tournament -- 7            # 7 bots join the first open tournament
npm run bots -w games/chess-tournament -- 500 2 --fast # 500 instant-moving bots join tournament #2
```

Stop them with Ctrl+C. Bot accounts are real rows in the database named "Bot 1", "Bot 2", and so on,
so don't run them against a real event.

## Development

Run these from the `event-hub` folder (one `npm install` there covers every game):

```
npm run dev -w games/chess-tournament    # server + live-reloading site at http://localhost:5176
npm test -w games/chess-tournament       # rules engine (perft), tournament simulations, hub API
```

The rules engine is `src/shared/engine/chess.ts`: a pure state machine over plain JSON, so a saved game
continues exactly where it stopped. `test/engine.test.ts` checks the move generator against the
standard perft counts.
