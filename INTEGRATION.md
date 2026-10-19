# Connecting a game to the hub

Any game site (Poker Night, Uno Night and Chess Night today) plugs into the hub by implementing five HTTP routes
and one webhook. The hub never reaches into a game's database; it only uses this contract.

The hub refers to a game's tournaments, matches or games as **events**. Players are identified by
their **Discord user ID**, so the game needs Discord login (or some other way to know each player's
Discord ID).

## Configuration on the game side

| Variable     | Example                  | Meaning                                          |
| ------------ | ------------------------ | ------------------------------------------------ |
| `HUB_URL`    | `http://127.0.0.1:3100`  | Where the hub listens. No trailing slash.         |
| `HUB_SECRET` | 64 hex characters        | Shared secret. Shown in the hub under **Games**.  |

When the hub runs the game (the usual case), it passes these itself; see *Letting the hub run the
server* below. If `HUB_SECRET` is empty, the game should answer integration routes with `503 {"error":"integration_disabled"}`.

## Signing (both directions)

Every request carries:

```
X-Hub-Timestamp: <epoch milliseconds>
X-Hub-Signature: hex(HMAC-SHA256(HUB_SECRET, "<timestamp>.<raw body>"))
```

The raw body is the exact bytes sent (`""` for GET). Reject with `401 {"error":"bad_signature"}`
if either header is missing, the signature doesn't match (compare in constant time), or the
timestamp is more than 5 minutes from now. Reference implementation: `src/server/signing.ts`.

## Routes the game serves (hub → game)

All JSON. Errors are `{"error": "<message for the admin>"}` with a 4xx status.

| Route | Returns |
| --- | --- |
| `GET /api/integration/info` | `GameInfo`: `{ key, name, fields: GameField[] }` — the dashboard builds the "New event" form from `fields`. |
| `POST /api/integration/events` | Body: `{ [field.name]: value }`. Creates the event, returns `GameEvent`. |
| `GET /api/integration/events?since=<ms>` | `GameEvent[]`: every open event, plus finished/cancelled ones that ended after `since` (even if the game no longer shows them). |
| `POST /api/integration/events/:id/:op` | `op` is `start`, `pause`, `resume` or `cancel`. Returns the updated `GameEvent`. |
| `GET /api/integration/events/:id/results` | `{ id, status, finishedAt, results: [{ discordId, username, place }] }`, sorted by place. |
| `POST /api/integration/shutdown` | *Optional.* Save, answer `{ ok: true }`, then exit. Lets the hub stop a server it runs (Windows can't send Ctrl+C to a background process). Without it the hub force-stops the process. |
| `GET /api/integration/events/:id/players` | *Optional (lobby controls).* `GameLobby`: `{ access, players: GamePlayer[] }`. A 404 hides the event's Lobby panel in the hub. |
| `POST /api/integration/events/:id/access` | Body: `{ access: "open" \| "closed" }`. Closed: registering only asks to join. Opening lets in everyone waiting. Returns `GameLobby`. |
| `POST /api/integration/events/:id/players/:discordId/:action` | `action` is `approve` or `deny` (a join request) or `kick` (removes the player for good: they're knocked out if it's running and can't register again). Returns `GameLobby`. |

Types are in `src/shared/protocol.ts`:

```ts
GameField = { name, label, type: "text" | "number" | "datetime" | "select", default?, min?, max?,
              options?: { value, label }[], help? }        // datetime values are epoch ms
GameEvent = { id: string, name, status: "registering" | "running" | "finished" | "cancelled",
              startTime, entrants, maxPlayers, startedAt, finishedAt, url,
              access?: "open" | "closed", pending?: number,          // pending = join requests waiting
              watchUrl?: string | null }
GamePlayer = { discordId, username, avatarUrl,
               status: "pending" | "registered" | "playing" | "waiting" | "out" | "removed" | "afk", place }
```

`removed` means an admin kicked the player. `afk` means the game removed them for staying away too long (see below). The hub shows it as "Removed (AFK)", next to their place when they have one.

`watchUrl` is optional: send it only while the event is running, pointing at the game's spectator page (games use `PUBLIC_URL/#/t/<id>/watch`). The hub then shows a "Watch live" link. Only `http(s)` links are kept, and leaving the field out clears it.

To let the admin choose the lobby when creating an event, offer an `access` select field (`open` / `closed`) in `info`.

### AFK kick (shared rule)

Games where a player who doesn't act gets played for automatically (poker today; Uno should follow the same rule) offer one `number` field in `info`. Chess doesn't need it: its clock already ends the game.

- **Field:** `afkKickMinutes`, min 0, max 60. 0 means never kick. Poker's default is 5.
- **When the countdown runs:** while the player is marked away, because they timed out, were disconnected when their turn came, or chose to sit out. Acting again or pressing "I'm back" resets it. Paused time and break time don't count, and a game restart starts every countdown over, so nobody is removed for the server's downtime.
- **When it runs out:** the player is removed the same way as an admin kick (folded out of a hand in progress first). They still get a finishing place and points, as if knocked out at that moment.
- **Telling people:** the table chat says the player was removed for being away too long, the player sees a countdown while sitting out, and the lobby reports them with status `afk`.
- **Older events** saved without the field: never kick, so events already running don't change.

## Webhook the game sends (game → hub)

When an event finishes (or is cancelled), POST, signed as above:

```
POST {HUB_URL}/api/games/{key}/webhook
{"type":"event.finished","externalId":"<event id>"}
```

Whenever an event's players change (someone registers, asks to join, is let in, knocked out or kicked),
send `{"type":"event.updated","externalId":"<event id>"}` the same way, at most about once a second per
event. The hub re-reads the game's events, so player counts on the dashboard stay live.

Fire and forget — no retries needed. The hub also polls every game every two minutes (every 15 seconds
while it has an event open or running), so a missed webhook only delays things; it never loses them. The results route must already return the final
places when the webhook is sent.

## Letting the hub run the server

Put the game in `games/<name>/` with its own `package.json` (it joins the hub's npm workspace). On
the hub's Games page, give it a **server folder** and a **start command** (run there with `cmd /c`,
e.g. `npm start`). The command must start the server in the foreground and keep running.

The game has no settings file of its own. The hub starts it with these environment variables:

| Variable | Value |
| --- | --- |
| `PORT` | The port from the game's address in the hub (e.g. 3000). Listen on 127.0.0.1. |
| `PUBLIC_URL` | Where players reach it: `https://<this PC>.ts.net[:port]` when *open to players* is on, else `http://localhost:<port>`. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | The hub's Discord application, for player sign-in. Redirect: `PUBLIC_URL/auth/discord/callback`. |
| `ADMIN_DISCORD_IDS` | Comma-separated Discord IDs of admins. |
| `HUB_URL`, `HUB_SECRET` | For signing (above). |
| `DB_PATH` | `event-hub/data/games/<key>/<key>.db`. Keep all of the game's data there. |
| `KEEP_AWAKE` | `false` (the hub keeps the PC awake). |

Never the bot token or the hub's own database. When *open to players* is on, the hub opens Tailscale
Funnel to the game's port before starting it, and closes it when the game stops. One game per public
port (443, 8443, 10000). See Poker Night (`games/poker-tournament`) Uno Night (`games/uno-tournament`) or Chess Night (`games/chess-tournament`) for a complete example.

## Registering the game

In the hub: **Games → Connect a game**, give it a key (e.g. `chess`), a name, its address (a free
port, e.g. `http://127.0.0.1:3001`), its folder and start command. No hub code changes are needed.
A game that runs somewhere the hub doesn't start it can still connect: its card shows the
`HUB_URL` / `HUB_SECRET` it needs.
