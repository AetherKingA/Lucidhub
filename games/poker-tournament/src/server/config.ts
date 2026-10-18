import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");

// LucidHub runs this server and passes every setting as an environment variable (see README.md).
// A .env here is only for running it on its own while developing; the hub's settings win over it.
const envFile = resolve(ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = (name: string, fallback?: string): string => {
  const v = process.env[name]?.trim() || fallback;
  if (v === undefined) throw new Error(`Missing ${name}. LucidHub provides it when it runs Poker Night (see README.md).`);
  return v;
};

const port = Number(env("PORT", "3000"));
const publicUrl = env("PUBLIC_URL", `http://localhost:${port}`).replace(/\/$/, "");

export const config = {
  port,
  /** The address players use, e.g. your Tailscale Funnel URL. Discord redirects back here. */
  publicUrl,
  secureCookies: publicUrl.startsWith("https://"),
  discord: {
    clientId: env("DISCORD_CLIENT_ID", ""),
    clientSecret: env("DISCORD_CLIENT_SECRET", ""),
    redirectUri: `${publicUrl}/auth/discord/callback`,
  },
  adminDiscordIds: new Set(env("ADMIN_DISCORD_IDS", "").split(",").map((s) => s.trim()).filter(Boolean)),
  sessionDays: Number(env("SESSION_DAYS", "30")),
  /** Tailscale Funnel proxies requests, so the real client IP comes from X-Forwarded-For. */
  trustProxy: env("TRUST_PROXY", "true") === "true",
  /** In the hub's data folder (event-hub/data/games/poker), where LucidHub keeps every game's data. */
  dbPath: resolve(ROOT, env("DB_PATH", "../../data/games/poker/poker.db")),
  distDir: resolve(ROOT, "dist"),
  /** Event Hub (the admin dashboard that hands out prizes). The integration is off while the secret is empty. */
  hub: {
    url: env("HUB_URL", "http://127.0.0.1:3100").replace(/\/$/, ""),
    secret: env("HUB_SECRET", ""),
  },
};

export const discordConfigured = Boolean(config.discord.clientId && config.discord.clientSecret);
