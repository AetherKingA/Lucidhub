# Connecting a game to the hub

Any game site (Poker Night today, chess later) plugs into the hub by implementing five HTTP routes
and one webhook. The hub never reaches into a game's database; it only uses this contract.

The hub refers to a game's tournaments, matches or games as **events**. Players are identified by
their **Discord user ID**, so the game needs Discord login (or some other way to know each player's
Discord ID).

## Configuration on the game side

| Variable     | Example                  | Meaning                                          |
| ------------ | ------------------------ | ------------------------------------------------ |
| `HUB_URL`    | `http://127.0.0.1:3100`  | Where the hub listens. No trailing slash.         |
| `HUB_SECRET` | 64 hex characters        | Shared secret. Shown in the hub under **Games**.  |

If `HUB_SECRET` is empty, the game should answer integration routes with `503 {"error":"integration_disabled"}`.

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

## Registering the game

In the hub: **Games → Connect a game**, give it a key (e.g. `chess`), a name and its address, then
copy the `HUB_URL` / `HUB_SECRET` lines into the game's `.env`. No hub code changes are needed.
