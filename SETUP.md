# Poker Night — host setup

You host the site on your own Windows PC. Players reach it through Tailscale Funnel, which gives your
PC a permanent public HTTPS address without opening ports on your router. One-time setup takes
about 15 minutes.

## 1. Install Tailscale and turn on Funnel

1. Install Tailscale from https://tailscale.com/download/windows and sign in (a free account is fine).
2. In a terminal, run:

   ```
   tailscale funnel 3000
   ```

   The first time, it prints a link to enable HTTPS certificates and Funnel for your account. Open it,
   approve, and run the command again. It then prints your public address, which looks like
   `https://your-pc-name.tail1234.ts.net`. Press Ctrl+C to stop it — `start.bat` runs it for you from now on.

## 2. Create the Discord application

1. Go to https://discord.com/developers/applications and click **New Application**. Give it your
   site's name.
2. Open **OAuth2** in the sidebar.
3. Copy the **Client ID**. Click **Reset Secret** and copy the **Client Secret**.
4. Under **Redirects**, add both of these (replace the address with yours from step 1):
   - `https://your-pc-name.tail1234.ts.net/auth/discord/callback`
   - `http://localhost:3000/auth/discord/callback` (for testing on your own PC)
5. Save.

## 3. Create your .env file

Copy `.env.example` to `.env` and fill in:

- `PUBLIC_URL` — your Tailscale address from step 1
- `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` — from step 2
- `ADMIN_DISCORD_IDS` — your own Discord user ID, so you get admin tools

Never share `.env`: the client secret lets anyone pretend to be your site to Discord.

## Running it

- **Start:** double-click `start.bat`. It builds the website, opens the Funnel and starts the server.
  The window shows your public address when it's ready.
- **Stop:** press Ctrl+C in that window (answer `N` if asked "Terminate batch job?" so it can close
  the Funnel), or just close the window.
- While the server runs, Windows won't go to sleep. The screen can still turn off.
- All data lives in `data/poker.db`. Back up that file to back up the site.

## For development

```
npm run dev     # server + live-reloading website at http://localhost:5173
npm test        # poker engine tests
```

## Troubleshooting

- **"Invalid OAuth2 redirect_uri" from Discord:** the redirect in step 2 must exactly match
  `PUBLIC_URL` + `/auth/discord/callback`.
- **Players see a 502 error:** the server isn't running, but the Funnel is. Start `start.bat`, or run
  `tailscale funnel --https=443 off`.
- **"Your Discord account needs a verified email":** that player has to verify their email in
  Discord's settings first. This is the anti-multi-account check.
