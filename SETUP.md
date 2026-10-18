# LucidHub — setup

The hub is your admin dashboard above all your games. You create events here (they run on the game
sites, like Poker Night), attach prizes, and the Discord bot DMs each winner their prize the moment
an event ends and announces the winners in your server. Set it up once and it runs by itself.

It runs on the same Windows PC as Poker Night and is **only reachable from this PC** (it isn't
exposed through Tailscale Funnel — it holds your prize codes). One-time setup takes about 10 minutes.

## 1. Add a bot to your Discord application

Use the same application you made for Poker Night (https://discord.com/developers/applications).

1. Open **Bot** in the sidebar. Click **Reset Token** and copy it — that's `DISCORD_BOT_TOKEN`.
2. On the same page, leave **Privileged Gateway Intents** all off; the bot doesn't need them.
3. Open **OAuth2** and, under **Redirects**, add `http://localhost:3100/auth/discord/callback`. Save.
4. Copy the **Client ID** and **Client Secret** (the same ones Poker Night uses).

## 2. Create your .env file

Copy `.env.example` to `.env` and fill in `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
`DISCORD_BOT_TOKEN` and `ADMIN_DISCORD_IDS` (your own Discord user ID).

Never share `.env`: the bot token lets anyone control your bot.

## 3. Start it and finish in the dashboard

1. Double-click `start.bat`. Open http://localhost:3100 and sign in with Discord.
2. **Settings → Invite the bot to a server**, pick your server, and approve. Back in Settings, choose
   the server, the channel to announce winners in, and a private channel for alerts (or leave it on
   "DM me"). Click **Send test message** to check the bot can post there.
3. **Games → Connect a game.** The defaults (Poker Night, `poker`, `http://127.0.0.1:3000`) are right
   for Poker Night on this PC. Click **Show setup**, copy the two lines into
   `poker-tournament/.env`, and restart Poker Night. **Test connection** should then say it works.
4. **Prizes → New prize.** A *code pool* gives each winner the next unused code (game keys, gift
   cards); paste codes one per line or upload a .txt/.csv. A *message* prize sends the same text to
   every winner (e.g. "Reply here with your shirt size").

## Running events

- **New event:** pick the game, fill in its options (for poker: start time, player cap, stack, blind
  speed…), add prizes by place (1st → $50 card, 2nd–3rd → game key), pick the announcement channel,
  and create it. It appears on the game site straight away.
- **That's it.** When the event ends, each winner gets a DM with their prize and the winners are
  announced in the channel (prize names only — codes are never posted publicly).
- Tournaments you create on the Poker Night site directly also show up under **Events**; open one to
  attach prizes before it ends. You can even add prizes after an event finished and they're sent then.
- **Save a ladder** you use often ("Weekly poker") and load it on the next event in one click.

### What happens when something goes wrong

- **A winner has DMs turned off:** the bot pings them in the announcement channel to type
  **/prizes**, which shows them their prize privately. You get an alert, and the **Deliveries** page
  lets you **Resend** or mark it **Delivered by hand**.
- **A code pool runs out:** winners wait in line and you get an alert. Add codes and they're sent
  automatically, oldest winner first. You're also warned when stock gets low.
- **The hub was off when an event ended:** start it again — within two minutes it checks every game
  and sends anything it missed. Nobody is ever paid twice.
- **The bot is offline or not set up:** prizes queue up and go out once it's back.

Winners can type **/prizes** in your server any time to see everything they've won. Admins can type
**/hub status** for a quick summary without opening the dashboard.

## Using the dashboard from your phone

The hub only listens on this PC. If you have Tailscale on your phone, run
`tailscale serve --bg 3100` once; the dashboard is then at `https://your-pc-name.tail1234.ts.net`
from your own devices only (not public). Set `PUBLIC_URL` to that address, add
`<that address>/auth/discord/callback` to the Discord redirects, and restart the hub.

## Backups

All data — prizes, unused codes, who won what — lives in `data/hub.db`. Back up that file.

## Testing without Discord

```
npm run dev-login -- "Your Name" 800000000000000001
```

prints a `hub_sid=...` line. Add `800000000000000001` to `ADMIN_DISCORD_IDS`, restart, open
http://localhost:3100, press F12, run `document.cookie = "hub_sid=...; path=/"` in the Console, and
reload. Without a bot token the dashboard works, but prizes wait in the queue.

## For development

```
npm run dev     # hub + live-reloading dashboard at http://localhost:5174
npm test        # award engine, delivery, signing and API tests
```

Adding another game (chess, …): see `INTEGRATION.md`.
