import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { registerAuthRoutes } from "./auth.ts";
import type { Bot } from "./bot.ts";
import { config } from "./config.ts";
import type { ProcessManager } from "./processes.ts";
import { registerRoutes } from "./routes.ts";

/** The hub's HTTP server: dashboard API, game webhooks, and the built dashboard. */
export async function buildApp(bot: Bot, servers: ProcessManager) {
  const app = Fastify({ logger: { level: "warn" } });
  await app.register(fastifyCookie);

  registerAuthRoutes(app);
  registerRoutes(app, bot, servers);
  app.get("/api/health", async () => ({ ok: true, bot: bot.ready() }));

  // Serve the built dashboard. Unknown non-API paths get index.html so client-side routes work.
  const hasBuild = existsSync(join(config.distDir, "index.html"));
  if (hasBuild) {
    await app.register(fastifyStatic, { root: config.distDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/auth/")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "not_found" });
    });
  } else {
    app.get("/", async (_req, reply) =>
      reply.type("text/html").send("<p>No dashboard build found. Run <code>npm run build</code>, or use <code>npm run dev</code>.</p>"),
    );
  }
  return { app, hasBuild };
}
