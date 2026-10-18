import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { registerAuthRoutes } from "./auth.ts";
import { config, discordConfigured } from "./config.ts";
import { db } from "./db.ts";
import { registerIntegrationRoutes } from "./integration.ts";
import { Realtime } from "./realtime.ts";
import { registerTournamentRoutes } from "./routes.ts";
import { TournamentManager } from "./tournament/manager.ts";

const app = Fastify({ logger: { level: "warn" }, trustProxy: config.trustProxy });

await app.register(fastifyCookie);
await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 } });

const realtime = new Realtime();
const manager = new TournamentManager(realtime);
realtime.manager = manager;
manager.load(Date.now());

registerAuthRoutes(app);
realtime.register(app);
registerTournamentRoutes(app, manager);
registerIntegrationRoutes(app, manager, () => void shutdown("Hub request"));
app.get("/api/health", async () => ({ ok: true, online: realtime.onlineCount() }));

// Serve the built website. Unknown non-API paths get index.html so client-side routes work.
const hasBuild = existsSync(join(config.distDir, "index.html"));
if (hasBuild) {
  await app.register(fastifyStatic, { root: config.distDir });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/auth/"))
      return reply.sendFile("index.html");
    return reply.code(404).send({ error: "not_found" });
  });
} else {
  app.get("/", async (_req, reply) =>
    reply.type("text/html").send("<p>No website build found. Run <code>npm run build</code>, or use <code>npm run dev</code>.</p>"),
  );
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} received, shutting down...`);
  try {
    manager.stop(); // saves every tournament; running ones come back paused on the next start
    await app.close();
  } finally {
    db.close();
    console.log("[server] Stopped cleanly.");
    process.exit(0);
  }
}
// SIGHUP is what Windows sends when the console window is closed.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.on(sig, () => void shutdown(sig));

await app.listen({ port: config.port, host: "127.0.0.1" });
manager.start();

console.log("");
console.log("  Poker server is running");
console.log(`  Local:   http://localhost:${config.port}`);
console.log(`  Public:  ${config.publicUrl}`);
if (!discordConfigured) console.log("  WARNING: Discord login is not configured. Fill in DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in LucidHub's .env.");
if (!hasBuild) console.log("  WARNING: No website build found (run npm run build).");
console.log("");
