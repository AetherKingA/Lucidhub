// Dashboard login with Discord. Only accounts listed in ADMIN_DISCORD_IDS can sign in.

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AdminInfo } from "../shared/protocol.ts";
import { config, discordLoginConfigured } from "./config.ts";
import { type Admin, createSession, deleteSession, findSession } from "./db.ts";

const SESSION_COOKIE = "hub_sid";
const STATE_COOKIE = "hub_oauth_state";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

const cookieOpts = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: config.secureCookies,
};

/** The signed-in admin for a request, or null. Removing someone from ADMIN_DISCORD_IDS locks them out at once. */
export function adminFromRequest(req: FastifyRequest): Admin | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const admin = findSession(hash(token));
  return admin && config.adminDiscordIds.has(admin.discordId) ? admin : null;
}

export function requireAdmin(req: FastifyRequest, reply: FastifyReply): Admin | null {
  const admin = adminFromRequest(req);
  if (!admin) reply.code(401).send({ error: "not_signed_in" });
  return admin;
}

function publicAdmin(a: Admin): AdminInfo {
  return {
    discordId: a.discordId,
    username: a.username,
    avatarUrl: a.avatar
      ? `https://cdn.discordapp.com/avatars/${a.discordId}/${a.avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(a.discordId) >> 22n) % 6n)}.png`,
  };
}

interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

/** Signs an admin in and returns the cookie token. Used by the OAuth callback and scripts/dev-login.ts. */
export function startSession(admin: Admin) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + config.sessionDays * 86_400_000;
  createSession(hash(token), admin, expiresAt);
  return { token, expiresAt };
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.get("/auth/discord", async (_req, reply) => {
    if (!discordLoginConfigured) return reply.redirect("/?error=not_configured");
    const state = randomBytes(16).toString("hex");
    reply.setCookie(STATE_COOKIE, state, { ...cookieOpts, maxAge: 600 });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.discord.clientId,
      scope: "identify",
      redirect_uri: config.discord.redirectUri,
      state,
      prompt: "none",
    });
    return reply.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/auth/discord/callback", async (req, reply) => {
    const { code, state, error } = req.query;
    const expected = req.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: "/" });
    if (error) return reply.redirect("/?error=cancelled");
    if (!code || !state || state !== expected) return reply.redirect("/?error=login_failed");

    let user: DiscordUser;
    try {
      user = await fetchDiscordUser(code);
    } catch (err) {
      req.log.error(err, "Discord login failed");
      return reply.redirect("/?error=login_failed");
    }
    if (!config.adminDiscordIds.has(user.id)) {
      console.log(`[auth] Refused dashboard login for ${user.username} (${user.id}) — not in ADMIN_DISCORD_IDS`);
      return reply.redirect("/?error=not_admin");
    }

    const { token, expiresAt } = startSession({ discordId: user.id, username: user.global_name || user.username, avatar: user.avatar });
    reply.setCookie(SESSION_COOKIE, token, { ...cookieOpts, expires: new Date(expiresAt) });
    console.log(`[auth] ${user.username} signed in to the dashboard`);
    return reply.redirect("/");
  });

  app.post("/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) deleteSession(hash(token));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req, reply) => {
    const admin = adminFromRequest(req);
    if (!admin) return reply.code(401).send({ error: "not_signed_in", discordConfigured: discordLoginConfigured });
    return publicAdmin(admin);
  });
}

async function fetchDiscordUser(code: string): Promise<DiscordUser> {
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${config.discord.clientId}:${config.discord.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.discord.redirectUri }),
  });
  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  const userRes = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${access_token}` } });
  if (!userRes.ok) throw new Error(`Fetching Discord user failed: ${userRes.status}`);
  return (await userRes.json()) as DiscordUser;
}
