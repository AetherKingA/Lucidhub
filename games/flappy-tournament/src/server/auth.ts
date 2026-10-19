import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config, discordConfigured } from "./config.ts";
import { type User, createSession, deleteSession, findSessionUser, upsertUser } from "./db.ts";

const SESSION_COOKIE = "sid";
const STATE_COOKIE = "oauth_state";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

const cookieOpts = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: config.secureCookies,
};

/** The signed-in user for a request (HTTP or WebSocket upgrade), or null. */
export function userFromRequest(req: FastifyRequest): User | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const user = findSessionUser(hash(token));
  return user && !user.banned ? user : null;
}

export function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    avatarUrl: user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(user.discordId) >> 22n) % 6n)}.png`,
    isAdmin: config.adminDiscordIds.has(user.discordId),
  };
}

export type PublicUser = ReturnType<typeof publicUser>;

interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
  verified?: boolean;
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.get("/auth/discord", async (_req, reply) => {
    if (!discordConfigured) return reply.redirect("/?error=not_configured");
    const state = randomBytes(16).toString("hex");
    reply.setCookie(STATE_COOKIE, state, { ...cookieOpts, maxAge: 600 });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.discord.clientId,
      scope: "identify email",
      redirect_uri: config.discord.redirectUri,
      state,
      prompt: "none",
    });
    return reply.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/auth/discord/callback",
    async (req, reply) => {
      const { code, state, error } = req.query;
      const expected = req.cookies[STATE_COOKIE];
      reply.clearCookie(STATE_COOKIE, { path: "/" });
      if (error) return reply.redirect("/?error=cancelled");
      if (!code || !state || state !== expected) return reply.redirect("/?error=login_failed");

      let discordUser: DiscordUser;
      try {
        discordUser = await fetchDiscordUser(code);
      } catch (err) {
        req.log.error(err, "Discord login failed");
        return reply.redirect("/?error=login_failed");
      }

      // Anti-alt: the Discord account must have a verified email.
      if (!discordUser.verified) return reply.redirect("/?error=unverified");

      const user = upsertUser(discordUser.id, discordUser.global_name || discordUser.username, discordUser.avatar);
      if (user.banned) return reply.redirect("/?error=banned");

      const token = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + config.sessionDays * 86_400_000;
      createSession(hash(token), user.id, expiresAt);
      reply.setCookie(SESSION_COOKIE, token, { ...cookieOpts, expires: new Date(expiresAt) });
      console.log(`[auth] ${user.username} signed in`);
      return reply.redirect("/");
    },
  );

  app.post("/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) deleteSession(hash(token));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req, reply) => {
    const user = userFromRequest(req);
    if (!user) return reply.code(401).send({ error: "not_signed_in", discordConfigured });
    return publicUser(user);
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

  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!userRes.ok) throw new Error(`Fetching Discord user failed: ${userRes.status}`);
  return (await userRes.json()) as DiscordUser;
}
