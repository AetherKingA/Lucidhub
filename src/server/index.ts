import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { registerAuthRoutes } from "./auth.ts";
import { config, discordConfigured } from "./config.ts";
import { db } from "./db.ts";
import { keepAwake } from "./keepAwake.ts";
import { onlineCount, registerRealtime } from "./realtime.ts";

const app = Fastify({ logger: { level: "warn" }, trustProxy: config.trustProxy });

await app.register(fastifyCookie);
await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 } });

registerAuthRoutes(app);
registerRealtime(app);
app.get("/api/health", async () => ({ ok: true, online: onlineCount() }));

// Serve the built website. Unknown non-API paths get index.html so client-side routes work.
const hasBuild = existsSync(join(config.distDir, "index.html"));
if (hasBuild) {
  await app.register(fastifyStatic, { root: config.distDir, wildcard: false });
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

const awake = config.keepAwake ? keepAwake() : null;

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} received, shutting down...`);
  try {
    await app.close();
  } finally {
    db.close();
    awake?.kill();
    console.log("[server] Stopped cleanly.");
    process.exit(0);
  }
}
// SIGHUP is what Windows sends when the console window is closed.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.on(sig, () => void shutdown(sig));

await app.listen({ port: config.port, host: "127.0.0.1" });

console.log("");
console.log("  Poker server is running");
console.log(`  Local:   http://localhost:${config.port}`);
console.log(`  Public:  ${config.publicUrl}`);
if (!discordConfigured) console.log("  WARNING: Discord login is not configured yet. See SETUP.md.");
if (!hasBuild) console.log("  WARNING: No website build found (run npm run build).");
console.log("  Press Ctrl+C or close this window to stop.");
console.log("");
