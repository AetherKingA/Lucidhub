# LucidHub (event-hub)

Admin hub for events and prizes: Node/TypeScript server, award engine, Discord bot that delivers prizes, and a React dashboard (Vite) that manages the game servers.

## Layout (read this instead of scanning folders)
- `src/server/index.ts`: hub server entry point (runs directly with node, no compile step)
- `src/`: server, award engine, Discord bot, dashboard code
- `games/`: npm workspaces, one per game: `poker-tournament`, `chess-tournament`, `uno-tournament`
- `test/`: hub tests (Vitest). `scripts/`: dev helpers such as `dev-login.ts`
- `data/`: runtime databases. `dist/`: built dashboard (generated, don't edit)
- `SETUP.md` (setup steps) and `INTEGRATION.md` (how games plug into the hub): open only when the task needs them

## Commands
- `npm run dev`: server and dashboard with live reload
- `npm test` (hub only) / `npm run test:all` (hub and all games)
- `npm run typecheck` / `npm run typecheck:all`
- `start.bat`: the normal way to launch; serves on http://localhost:3100 (health check at `/api/health`)

## Rules
- The hub database holds hub data only. Game servers must never write their tables into the hub DB.
- Reset any ready or status flags on crash or restart. Never trust a saved `ready=true` after an unclean shutdown.
- Discord settings in `.env` (token, guild, channel IDs) need placeholder or dev values so tests can start without real credentials. Never print real values from `.env`.
- A feature that spans all three games should follow one shared contract; implement it per game in `games/<name>/`.
