import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");

const envFile = resolve(ROOT, ".env");
if (existsSync(envFile) && !process.env.VITEST) process.loadEnvFile(envFile);

const env = (name: string, fallback?: string): string => {
  const v = process.env[name]?.trim() || fallback;
  if (v === undefined) throw new Error(`Missing ${name} in .env (see .env.example and SETUP.md)`);
  return v;
};

const port = Number(env("PORT", "3100"));
const publicUrl = env("PUBLIC_URL", `http://localhost:${port}`).replace(/\/$/, "");
const dbPath = env("DB_PATH", "data/hub.db");

export const config = {
  port,
  /** Where you open the dashboard. Discord redirects back here after login. */
  publicUrl,
  secureCookies: publicUrl.startsWith("https://"),
  discord: {
    clientId: env("DISCORD_CLIENT_ID", ""),
    clientSecret: env("DISCORD_CLIENT_SECRET", ""),
    redirectUri: `${publicUrl}/auth/discord/callback`,
    botToken: env("DISCORD_BOT_TOKEN", ""),
  },
  adminDiscordIds: new Set(env("ADMIN_DISCORD_IDS", "").split(",").map((s) => s.trim()).filter(Boolean)),
  sessionDays: Number(env("SESSION_DAYS", "30")),
  keepAwake: env("KEEP_AWAKE", "true") === "true",
  dbPath: dbPath === ":memory:" ? dbPath : resolve(ROOT, dbPath),
  distDir: resolve(ROOT, "dist"),
};

export const discordLoginConfigured = Boolean(config.discord.clientId && config.discord.clientSecret);
