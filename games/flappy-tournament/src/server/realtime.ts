import type { FastifyInstance } from "fastify";
import type { ClientMessage, ServerMessage, UserInfo } from "../shared/protocol.ts";
import { publicUser, userFromRequest } from "./auth.ts";
import type { Notifier, TournamentManager } from "./tournament/manager.ts";
import { TournamentError } from "./tournament/tournament.ts";

/** The parts of a WebSocket this uses (tests pass a fake). */
export interface SocketLike {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  ping(): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
}

interface Client {
  socket: SocketLike;
  user: UserInfo;
  alive: boolean;
  /** The tournament page this client has open, if any. */
  open: number | null;
  /** Simple rate limit: messages left in the current second. */
  budget: number;
}

const LOBBY_THROTTLE_MS = 1000;
const VIEW_THROTTLE_MS = 250;
const MAX_MESSAGES_PER_SECOND = 20;
/** A run's flap list can be long (up to 30 minutes of flying). */
export const MAX_PAYLOAD = 256 * 1024;

/**
 * WebSocket layer. Everyone gets the lobby; people with a tournament open get its view, built for
 * each person so nobody ever receives someone else's score before the finale.
 */
export class Realtime implements Notifier {
  manager!: TournamentManager;
  private clients = new Set<Client>();
  private byUser = new Map<number, Set<Client>>();
  private lobbyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastLobby = 0;
  private dirtyViews = new Set<number>();
  private viewTimer: ReturnType<typeof setTimeout> | null = null;

  // ------------------------------------------------------------ Notifier

  isConnected(userId: number) {
    return (this.byUser.get(userId)?.size ?? 0) > 0;
  }

  lobbyChanged() {
    if (this.lobbyTimer) return;
    const wait = Math.max(0, this.lastLobby + LOBBY_THROTTLE_MS - Date.now());
    this.lobbyTimer = setTimeout(() => {
      this.lobbyTimer = null;
      this.lastLobby = Date.now();
      for (const c of this.clients) this.sendLobby(c);
    }, wait);
  }

  tournamentChanged(tournamentId: number) {
    this.dirtyViews.add(tournamentId);
    if (!this.viewTimer) this.viewTimer = setTimeout(() => this.flushViews(), VIEW_THROTTLE_MS);
  }

  // ------------------------------------------------------------ connections

  register(app: FastifyInstance) {
    app.get("/ws", { websocket: true }, (socket, req) => {
      const user = userFromRequest(req);
      if (!user) {
        socket.close(4001, "Not signed in");
        return;
      }
      this.connect(socket, publicUser(user));
    });

    // Drop connections that stopped answering, and refill rate-limit budgets.
    const heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) {
          c.socket.terminate();
          continue;
        }
        c.alive = false;
        c.socket.ping();
      }
    }, 15_000);
    const budgets = setInterval(() => {
      for (const c of this.clients) c.budget = MAX_MESSAGES_PER_SECOND;
    }, 1000);
    app.addHook("onClose", async () => {
      clearInterval(heartbeat);
      clearInterval(budgets);
      if (this.viewTimer) clearTimeout(this.viewTimer);
      if (this.lobbyTimer) clearTimeout(this.lobbyTimer);
      for (const c of this.clients) c.socket.close(1001, "Server shutting down");
    });
  }

  /** A signed-in user's socket is ready. */
  connect(socket: SocketLike, user: UserInfo) {
    const client: Client = { socket, user, alive: true, open: null, budget: MAX_MESSAGES_PER_SECOND };
    this.clients.add(client);
    if (!this.byUser.has(user.id)) this.byUser.set(user.id, new Set());
    this.byUser.get(user.id)!.add(client);

    this.send(client, { type: "hello", user, serverNow: Date.now() });
    this.sendLobby(client);

    socket.on("pong", () => (client.alive = true));
    socket.on("message", (raw) => this.onMessage(client, String(raw)));
    socket.on("close", () => this.onClose(client));
    return client;
  }

  private onClose(client: Client) {
    this.clients.delete(client);
    const mine = this.byUser.get(client.user.id);
    mine?.delete(client);
    if (mine && mine.size === 0) this.byUser.delete(client.user.id);
  }

  onMessage(client: Client, raw: string) {
    if (client.budget-- <= 0) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const now = Date.now();
    const userId = client.user.id;

    try {
      if (msg.type === "ping") {
        this.send(client, { type: "pong", t: Number(msg.t), serverNow: now });
        return;
      }
      if (msg.type === "open") {
        client.open = msg.tournamentId === null ? null : Number(msg.tournamentId);
        if (client.open !== null) this.sendView(client, client.open, now);
        return;
      }
      const t = this.manager.get(Number(msg.tournamentId));
      if (!t) throw new TournamentError("Tournament not found");

      switch (msg.type) {
        case "register":
          t.register({ id: userId, username: client.user.username, avatarUrl: client.user.avatarUrl }, now);
          break;
        case "unregister":
          t.unregister(userId);
          break;
        case "runStart":
          t.startRun(userId, now);
          this.send(client, { type: "runStarted", tournamentId: t.id });
          break;
        case "runEnd": {
          const r = t.endRun(userId, msg.flaps, now);
          for (const c of this.byUser.get(userId) ?? []) this.send(c, { type: "runSaved", tournamentId: t.id, ...r });
          break;
        }
      }
    } catch (err) {
      if (err instanceof TournamentError) this.send(client, { type: "error", message: err.message });
      else {
        console.error("[ws] Error handling message:", err);
        this.send(client, { type: "error", message: "Something went wrong" });
      }
    }
  }

  // ------------------------------------------------------------ sending

  private flushViews() {
    this.viewTimer = null;
    const now = Date.now();
    for (const c of this.clients) if (c.open !== null && this.dirtyViews.has(c.open)) this.sendView(c, c.open, now);
    this.dirtyViews.clear();
  }

  private sendView(c: Client, tournamentId: number, now: number) {
    const view = this.manager.view(tournamentId, c.user.id, now);
    if (view) this.send(c, { type: "tournament", view, serverNow: now });
  }

  private sendLobby(c: Client) {
    const now = Date.now();
    this.send(c, { type: "lobby", tournaments: this.manager.list(c.user.id, now), serverNow: now });
  }

  private send(c: Client, msg: ServerMessage) {
    if (c.socket.readyState === c.socket.OPEN) c.socket.send(JSON.stringify(msg));
  }

  onlineCount() {
    return this.byUser.size;
  }
}
