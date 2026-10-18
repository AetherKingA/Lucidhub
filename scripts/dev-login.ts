// Prints a dashboard session cookie for a local test admin, for trying the hub without Discord login.
//
//   node scripts/dev-login.ts "Display Name" [discordId]
//
// The Discord ID must be in ADMIN_DISCORD_IDS in .env. Then, on http://localhost:3100, run in the
// browser console:  document.cookie = "hub_sid=<token>; path=/"

import { startSession } from "../src/server/auth.ts";

const name = process.argv[2] ?? "Test Admin";
const discordId = process.argv[3] ?? "800000000000000001";
const { token } = startSession({ discordId, username: name, avatar: null });
console.log(`Admin "${name}" (Discord ID ${discordId})`);
console.log(`hub_sid=${token}`);
