# LucidHub — setup

LucidHub is the one thing you run. It's your admin dashboard, it runs your games (Poker Night, Uno
Night and Chess Night), opens them to players on the internet, and its Discord bot DMs each
winner their prize the moment an event ends and announces the winners in your server. Set it up once
and it runs by itself.

- **One settings file:** `event-hub/.env`. Games get what they need from LucidHub; they have no
  settings file of their own.
- **One data folder:** `event-hub/data/`. The hub's data is in `hub.db`, each game's in
  `games/<game>/`, server logs in `logs/`.
- **Games live in `games/`** (Poker Night is `games/poker-tournament`, Uno Night is
  `games/uno-tournament`, Chess Night is `games/chess-tournament`). Everything is one git repo and one `npm install`.

The dashboard itself is **only reachable from this PC** (it holds your prize codes). Players reach
the games through Tailscale Funnel.

## 1. Discord application

Use one application for everything: https://discord.com/developers/applications

1. **Bot** page: click **Reset Token** and copy it (`DISCORD_BOT_TOKEN`). Leave the Privileged
   Gateway Intents off; the bot doesn't need them.
2. **OAuth2** page: copy the **Client ID** and **Client Secret**. Under **Redirects**, add
   `http://localhost:3100/auth/discord/callback` (your dashboard login) and click **Save Changes**.
   You'll add one more redirect per game in step 4. LucidHub shows you the exact address.

## 2. Settings file

Copy `.env.example` to `.env` and fill in `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
`DISCORD_BOT_TOKEN` and `ADMIN_DISCORD_IDS` (your Discord user ID: Settings → Advanced → Developer
Mode, then right-click your name → Copy User ID). Never share `.env`.

## 3. Tailscale (so players can reach your games)

Install Tailscale from https://tailscale.com/download/windows and sign in. That's all: LucidHub opens
the Funnel itself when it starts a public game. The first time, Tailscale may ask you to approve
Funnel for this PC. LucidHub then shows an **Approve** link on the Games page (and alerts you).
Click it, approve, and press **Restart**.

## 4. Start LucidHub and finish in the dashboard

1. Double-click the **LucidHub** shortcut on your desktop (or `start.bat` here). The first start
   installs everything, which takes a minute. The dashboard opens in your browser; sign in.
2. **Settings → Invite the bot to a server**, pick your server, and approve. Back in Settings, choose
   the server, the channel to announce winners in, and a private channel for alerts (or leave it on
   "DM me"). Click **Send test message** to check.
3. **Games → Poker Night.** Connect it if it isn't there yet. Its settings are pre-filled: folder
   `games\poker-tournament`, start command `npm start`, *start with LucidHub* and *open to players*
   ticked. Click **Start**.
   **Uno Night** works the same way: **Connect a game**, key `uno`, and everything is pre-filled
   (folder `games\uno-tournament`, address `http://127.0.0.1:3001`, public on port **8443** so it
   doesn't clash with Poker Night on the main address).
   **Chess Night** too: key `chess`, folder `gameschess-tournament`, address
   `http://127.0.0.1:3002`, public on port **10000**.
4. When a game is running, the Games page shows the address players use and **the Discord redirect
   it needs** (each game has its own). Copy that redirect into Discord (OAuth2 → Redirects → Save
   Changes). Without it, players get "Invalid OAuth2 redirect_uri" when they sign in.
5. **Prizes → New prize.** A *code pool* gives each winner the next unused code (game keys, gift
   cards); paste codes one per line or upload a .txt/.csv. A *message* prize sends the same text to
   every winner (e.g. "Reply here with your shirt size").

## Game servers

- **Games** shows each server as Running, Stopped or Crashed, with **Start**, **Stop**, **Restart**
  and a live **Log** (also saved in `data/logs/`).
- Servers set to *start with LucidHub* come up with it and are restarted automatically if they
  crash. After five crashes in ten minutes LucidHub stops retrying and alerts you. Check the log.
- **Stop** asks the game to save and exit (Poker Night and Uno Night save every tournament; running
  ones come back paused) and closes its Funnel. Closing the LucidHub window does the same for every
  game.
- While LucidHub runs, Windows won't go to sleep. The screen can still turn off.

## Running events

- **New event:** pick the game, fill in its options (for poker: start time, player cap, stack, blind
  speed…; for Uno: players per table, hands to win a table, stacking…; for chess: games to win a match,
  time control), add prizes by place (1st →
  $50 card, 2nd–3rd → game key), pick the announcement channel, and create it. It appears on the
  game site straight away.
- **That's it.** When the event ends, each winner gets a DM with their prize and the winners are
  announced in the channel (prize names only; codes are never posted publicly).
- Tournaments created on a game site directly also show up under **Events**; open one to
  attach prizes before it ends. You can even add prizes after an event finished and they're sent then.
- **Save a ladder** you use often ("Weekly poker") and load it on the next event in one click.
- How the tournaments work (format, pausing, shared-IP flags): `games/poker-tournament/README.md`,
  `games/uno-tournament/README.md` and `games/chess-tournament/README.md`.

### Lobby and players

An event's page has a **Lobby** panel while it's upcoming or running:

- **Open / Closed:** in a closed lobby players ask to join and you **Let in** or **Turn down** each one.
  Opening the lobby lets everyone waiting in.
- **Kick** removes a player for good: they're knocked out if it's running and can't register again.
- **Details** on a player shows their Discord ID and account age, when they joined, whether they're
  on the game site now, the IPs they've used (with a rough location and network), and any other
  account that has used the same IP.

**IP locations** come from the free DB-IP Lite databases, looked up on this PC (IPs are never sent
anywhere). Download *IP to City Lite* and *IP to ASN Lite* in MMDB format from
<https://db-ip.com/db/lite.php>, unzip them, and put the `.mmdb` files in `event-hub/data/geoip/`.
LucidHub picks them up within a minute; for fresher data, drop in next month's files the same way
(the newest is used). Without them everything else still works, just without locations. Locations are
approximate (city level at best, and a VPN shows the VPN's location). The data is licensed CC BY 4.0:
"IP Geolocation by DB-IP".

### What happens when something goes wrong

- **A winner has DMs turned off:** the bot pings them in the announcement channel to type
  **/prizes**, which shows them their prize privately. You get an alert, and the **Deliveries** page
  lets you **Resend** or mark it **Delivered by hand**.
- **A code pool runs out:** winners wait in line and you get an alert. Add codes and they're sent
  automatically, oldest winner first. You're also warned when stock gets low.
- **LucidHub was off when an event ended:** start it again. Within two minutes it checks every game
  and sends anything it missed. Nobody is ever paid twice.
- **The bot is offline or not set up:** prizes queue up and go out once it's back.

Winners can type **/prizes** in your server any time to see everything they've won. Admins can type
**/hub status** for a quick summary without opening the dashboard.

## Troubleshooting

- **"Invalid OAuth2 redirect_uri" from Discord:** the address isn't in your Discord application's
  Redirects, character for character. The dashboard needs `http://localhost:3100/auth/discord/callback`;
  each public game needs the redirect shown on its Games card. Click **Save Changes** after adding.
- **Players can't open a game:** check its Games card. An **Approve** link means Tailscale
  needs your one-time OK. "Tailscale isn't connected" means open Tailscale and sign in. Then Restart.
- **Players see a 502 error:** Funnel is open but the game isn't running. Start it on the Games page.

## Using the dashboard from your phone

The dashboard only listens on this PC. If you have Tailscale on your phone, run
`tailscale serve --bg --https=10000 3100` once; the dashboard is then at
`https://your-pc-name.tail1234.ts.net:10000` from your own devices only (not public). Set
`PUBLIC_URL` to that address, add `<that address>/auth/discord/callback` to the Discord redirects,
and restart LucidHub. (Port 10000 keeps it clear of the public game on the main address.)

## Backups

Back up the `data/` folder: prizes, unused codes, who won what, and every game's data.

## Testing without Discord

```
npm run dev-login -- "Your Name" 800000000000000001
```

prints a `hub_sid=...` line. Add `800000000000000001` to `ADMIN_DISCORD_IDS`, restart, open
http://localhost:3100, press F12, run `document.cookie = "hub_sid=...; path=/"` in the Console, and
reload. Without a bot token the dashboard works, but prizes wait in the queue.

## For development

```
npm run dev        # hub + live-reloading dashboard at http://localhost:5174
npm test           # hub tests (awards, delivery, signing, game servers, API)
npm run test:all   # hub and every game
```

Adding another game (chess, …): see `INTEGRATION.md`.
