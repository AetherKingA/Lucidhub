import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import { type PublicUser, publicUser, userFromRequest } from "./auth.ts";
import { recordIp } from "./db.ts";

interface Client {
  socket: WebSocket;
  user: PublicUser;
  alive: boolean;
}

const clients = new Set<Client>();

export function send(client: Client, msg: ServerMessage) {
  if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(msg));
}

export function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.socket.readyState === c.socket.OPEN) c.socket.send(data);
}

/** Distinct signed-in players connected right now (one player may have several tabs open). */
export function onlineCount() {
  return new Set([...clients].map((c) => c.user.id)).size;
}

export function registerRealtime(app: FastifyInstance) {
  app.get("/ws", { websocket: true }, (socket, req) => {
    const user = userFromRequest(req);
    if (!user) {
      socket.close(4001, "Not signed in");
      return;
    }
    recordIp(user.id, req.ip);

    const client: Client = { socket, user: publicUser(user), alive: true };
    clients.add(client);
    send(client, { type: "hello", user: client.user, online: onlineCount() });
    broadcast({ type: "online", count: onlineCount() });

    socket.on("pong", () => (client.alive = true));
    socket.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "ping") send(client, { type: "pong", t: msg.t });
      // Tournament and table messages are handled here once the tournament manager exists.
    });
    socket.on("close", () => {
      clients.delete(client);
      broadcast({ type: "online", count: onlineCount() });
    });
  });

  // Drop connections that stopped answering (e.g. a laptop lid closed) so seats can be marked away.
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.socket.terminate();
        continue;
      }
      c.alive = false;
      c.socket.ping();
    }
  }, 15_000);
  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    for (const c of clients) c.socket.close(1001, "Server shutting down");
  });
}
