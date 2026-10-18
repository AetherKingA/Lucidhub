import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { publicUser, userFromRequest } from "./auth.ts";
import type { CreateOptions, TournamentManager } from "./tournament/manager.ts";
import { TournamentError } from "./tournament/tournament.ts";

function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const user = userFromRequest(req);
  if (!user || !publicUser(user).isAdmin) {
    reply.code(403).send({ error: "Admins only" });
    return null;
  }
  return user;
}

export function registerTournamentRoutes(app: FastifyInstance, manager: TournamentManager) {
  app.get("/api/tournaments", async (req) => manager.list(userFromRequest(req)?.id ?? null));

  app.get<{ Params: { id: string } }>("/api/tournaments/:id", async (req, reply) => {
    const detail = manager.detail(Number(req.params.id), userFromRequest(req)?.id ?? null);
    return detail ?? reply.code(404).send({ error: "Tournament not found" });
  });

  app.post<{ Body: CreateOptions }>("/api/admin/tournaments", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const t = manager.create(req.body ?? ({} as CreateOptions), Date.now());
    return t.summary(null);
  });

  app.post<{ Params: { id: string; op: string }; Body: { userId?: number } }>(
    "/api/admin/tournaments/:id/:op",
    async (req, reply) => {
      const admin = requireAdmin(req, reply);
      if (!admin) return;
      const t = manager.get(Number(req.params.id));
      if (!t) return reply.code(404).send({ error: "Tournament not found" });
      const now = Date.now();
      try {
        switch (req.params.op) {
          case "start":
            t.start(now);
            break;
          case "pause":
            t.pause(`Paused by ${admin.username}`, now);
            break;
          case "resume":
            t.resume(now);
            break;
          case "cancel":
            t.cancel(now);
            break;
          case "kick":
            t.kick(Number(req.body?.userId));
            break;
          default:
            return reply.code(404).send({ error: "Unknown operation" });
        }
      } catch (err) {
        if (err instanceof TournamentError) return reply.code(400).send({ error: err.message });
        throw err;
      }
      console.log(`[admin] ${admin.username}: ${req.params.op} "${t.config.name}"`);
      return t.summary(null);
    },
  );

  app.get<{ Params: { id: string } }>("/api/admin/tournaments/:id/flags", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return manager.ipFlags(Number(req.params.id));
  });
}
