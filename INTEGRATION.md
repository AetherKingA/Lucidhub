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

Types are in `src/shared/protocol.ts`:

```ts
GameField = { name, label, type: "text" | "number" | "datetime" | "select", default?, min?, max?,
              options?: { value, label }[], help? }        // datetime values are epoch ms
GameEvent = { id: string, name, status: "registering" | "running" | "finished" | "cancelled",
              startTime, entrants, maxPlayers, startedAt, finishedAt, url }
```

## Webhook the game sends (game → hub)

When an event finishes (or is cancelled), POST, signed as above:

```
POST {HUB_URL}/api/games/{key}/webhook
{"type":"event.finished","externalId":"<event id>"}
```

Fire and forget — no retries needed. The hub also polls every game every two minutes, so a missed
webhook only delays prizes; it never loses them. The results route must already return the final
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
