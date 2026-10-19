// Prints a session cookie for a local test account, for trying the site without Discord.
//
//   node scripts/dev-login.ts "Display Name" [discordId]
//
// Then, on http://localhost:3003, run in the browser console:  document.cookie = "sid=<token>; path=/"
// To make the account an admin, put its Discord ID in ADMIN_DISCORD_IDS in .env and restart.

import { createHash, randomBytes } from "node:crypto";
import { createSession, upsertUser } from "../src/server/db.ts";

const name = process.argv[2] ?? "Test Player";
const discordId = process.argv[3] ?? "800000000000000001";
const user = upsertUser(discordId, name, null);
const token = randomBytes(32).toString("base64url");
createSession(createHash("sha256").update(token).digest("hex"), user.id, Date.now() + 7 * 86_400_000);
console.log(`Account "${name}" (Discord ID ${discordId})`);
console.log(`sid=${token}`);
