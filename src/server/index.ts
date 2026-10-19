import { spawn } from "node:child_process";
import { setAlertSink } from "./alerts.ts";
import { buildApp } from "./app.ts";
import { Bot } from "./bot.ts";
import { config, discordLoginConfigured } from "./config.ts";
import { db } from "./db.ts";
import { DeliveryWorker } from "./delivery.ts";
import { keepAwake } from "./keepAwake.ts";
import { ProcessManager } from "./processes.ts";
import { syncAll } from "./sync.ts";

const DELIVERY_EVERY_MS = 10_000;
const SYNC_EVERY_MS = 2 * 60_000;

const bot = new Bot();
const worker = new DeliveryWorker(bot);
const servers = new ProcessManager();
setAlertSink((message) => bot.alert(message));

const { app, hasBuild } = await buildApp(bot, servers);
await app.listen({ port: config.port, host: "127.0.0.1" });
await bot.start();
// Game servers set to "start with LucidHub" come up with the hub.
void servers.startAutostart();

const runSafely = (what: string, fn: () => Promise<unknown>) => () =>
  void fn().catch((err) => console.error(`[hub] ${what} failed:`, err));
const deliverTimer = setInterval(runSafely("Delivery", () => worker.tick()), DELIVERY_EVERY_MS);
const syncTimer = setInterval(runSafely("Sync", syncAll), SYNC_EVERY_MS);
runSafely("Sync", syncAll)();

const awake = config.keepAwake ? keepAwake() : null;

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[hub] ${signal} received, shutting down...`);
  try {
    clearInterval(deliverTimer);
    clearInterval(syncTimer);
    await servers.stopAll(); // each game saves its state and exits
    await bot.stop();
    await app.close();
  } finally {
    db.close();
    awake?.kill();
    console.log("[hub] Stopped cleanly.");
    process.exit(0);
  }
}
// SIGHUP is what Windows sends when the console window is closed.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.on(sig, () => void shutdown(sig));

console.log("");
console.log("  LucidHub is running");
console.log(`  Dashboard: ${config.publicUrl}`);
if (!discordLoginConfigured) console.log("  WARNING: Discord login is not configured yet. See SETUP.md.");
if (!config.discord.botToken) console.log("  WARNING: DISCORD_BOT_TOKEN is not set, so prizes can't be sent yet. See SETUP.md.");
if (config.adminDiscordIds.size === 0) console.log("  WARNING: ADMIN_DISCORD_IDS is empty, so nobody can sign in. See SETUP.md.");
if (!hasBuild) console.log("  WARNING: No dashboard build found (run npm run build).");
console.log("  Press Ctrl+C or close this window to stop.");
console.log("");

// start.bat (and the desktop shortcut) open the dashboard once it's up.
if (process.env.OPEN_DASHBOARD === "1" && process.platform === "win32") {
  spawn("cmd.exe", ["/d", "/c", "start", "", config.publicUrl], { stdio: "ignore", windowsHide: true, detached: true }).unref();
}
