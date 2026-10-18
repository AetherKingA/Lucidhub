import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { Action, ChatMessage, ClientMessage, ServerMessage } from "../shared/protocol.ts";
import { type PublicUser, publicUser, userFromRequest } from "./auth.ts";
import { ChatError, TableChats } from "./chat.ts";
import { recordIp } from "./db.ts";
import type { Notifier, TournamentManager } from "./tournament/manager.ts";
import { TournamentError } from "./tournament/tournament.ts";

interface Client {
  socket: WebSocket;
  user: PublicUser;
  alive: boolean;
  /** Table keys ("tournamentId:tableId") this client receives updates for. */
  subs: Set<string>;
  /** The table being spectated (not the player's own), if any. */
  spectating: string | null;
  /** Simple rate limit: messages left in the current second. */
  budget: number;
}

const key = (tournamentId: number, tableId: number) => `${tournamentId}:${tableId}`;
const LOBBY_THROTTLE_MS = 1000;
const MAX_MESSAGES_PER_SECOND = 20;

/**
 * WebSocket hub. Sends the lobby to everyone, and table updates to the players seated at that table
 * (each with only their own hole cards) plus any spectators.
 */
export class Realtime implements Notifier {
  manager!: TournamentManager;
  private clients = new Set<Client>();
  private byUser = new Map<number, Set<Client>>();
  private watchers = new Map<string, Set<Client>>();
  private dirtyTables = new Set<string>();
  private flushQueued = false;
  private lobbyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastLobby = 0;
  readonly chats = new TableChats();

  // ------------------------------------------------------------ Notifier

  handComplete(tournamentId: number, tableId: number, lines: string[]) {
    const k = key(tournamentId, tableId);
    const now = Date.now();
    const messages = lines.map((l) => this.chats.dealer(k, l, now));
    if (messages.length) this.sendChat(k, tournamentId, tableId, messages);
  }

  isConnected(userId: number) {
    return (this.byUser.get(userId)?.size ?? 0) > 0;
  }

  tableChanged(tournamentId: number, tableId: number) {
    this.dirtyTables.add(key(tournamentId, tableId));
    if (!this.flushQueued) {
      this.flushQueued = true;
      setImmediate(() => this.flushTables());
    }
  }

  tableClosed(tournamentId: number, tableId: number) {
    const k = key(tournamentId, tableId);
    for (const c of this.watchers.get(k) ?? []) {
      c.subs.delete(k);
      if (c.spectating === k) c.spectating = null;
      this.send(c, { type: "tableClosed", tournamentId, tableId });
    }
    this.watchers.delete(k);
    this.dirtyTables.delete(k);
    this.chats.drop(k);
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

  playerMoved(tournamentId: number, userId: number, tableId: number) {
    for (const c of this.byUser.get(userId) ?? []) {
      // Drop the old own-table subscription for this tournament.
      for (const k of [...c.subs]) if (k.startsWith(`${tournamentId}:`) && k !== c.spectating) this.unsubscribe(c, k);
      this.subscribe(c, key(tournamentId, tableId));
      this.send(c, { type: "moved", tournamentId, tableId });
    }
    this.tableChanged(tournamentId, tableId);
  }

  playerAdvanced(tournamentId: number, userId: number, round: number, totalRounds: number) {
    for (const c of this.byUser.get(userId) ?? []) this.send(c, { type: "advanced", tournamentId, round, totalRounds });
    this.lobbyChanged();
  }

  playerFinished(tournamentId: number, userId: number, place: number, points: number) {
    for (const c of this.byUser.get(userId) ?? []) this.send(c, { type: "finished", tournamentId, place, points });
  }

  // ------------------------------------------------------------ connections

  register(app: FastifyInstance) {
    app.get("/ws", { websocket: true }, (socket, req) => {
      const user = userFromRequest(req);
      if (!user) {
        socket.close(4001, "Not signed in");
        return;
      }
      recordIp(user.id, req.ip);

      const client: Client = { socket, user: publicUser(user), alive: true, subs: new Set(), spectating: null, budget: MAX_MESSAGES_PER_SECOND };
      this.clients.add(client);
      const wasConnected = this.isConnected(user.id);
      if (!this.byUser.has(user.id)) this.byUser.set(user.id, new Set());
      this.byUser.get(user.id)!.add(client);

      this.send(client, { type: "hello", user: client.user, online: this.byUser.size, serverNow: Date.now() });
      this.sendLobby(client);
      // Subscribe to the player's own tables.
      for (const t of this.manager.tournaments.values()) {
        const loc = t.locate(user.id);
        if (loc) {
          this.subscribe(client, key(t.id, loc.table.id));
          this.tableChanged(t.id, loc.table.id); // also refreshes their "connected" dot for others
        }
      }
      if (!wasConnected) this.broadcast({ type: "online", count: this.byUser.size });

      socket.on("pong", () => (client.alive = true));
      socket.on("message", (raw) => this.onMessage(client, String(raw)));
      socket.on("close", () => this.onClose(client));
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
      for (const c of this.clients) c.socket.close(1001, "Server shutting down");
    });
  }

  private onClose(client: Client) {
    this.clients.delete(client);
    for (const k of client.subs) this.watchers.get(k)?.delete(client);
    const mine = this.byUser.get(client.user.id);
    mine?.delete(client);
    if (mine && mine.size === 0) {
      this.byUser.delete(client.user.id);
      this.broadcast({ type: "online", count: this.byUser.size });
      // Others at their table should see them as disconnected.
      for (const t of this.manager.tournaments.values()) {
        const loc = t.locate(client.user.id);
        if (loc) this.tableChanged(t.id, loc.table.id);
      }
    }
  }

  private onMessage(client: Client, raw: string) {
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
      const t = this.manager.get(Number(msg.tournamentId));
      if (!t) throw new TournamentError("Tournament not found");

      switch (msg.type) {
        case "register":
          t.register({ id: userId, username: client.user.username, avatarUrl: client.user.avatarUrl }, now);
          break;
        case "unregister":
          t.unregister(userId);
          break;
        case "watch": {
          if (client.spectating) this.unsubscribe(client, client.spectating);
          client.spectating = null;
          if (msg.tableId !== null && t.tables.has(Number(msg.tableId))) {
            const k = key(t.id, Number(msg.tableId));
            const own = t.locate(userId)?.table.id === Number(msg.tableId);
            if (!own) client.spectating = k;
            this.subscribe(client, k);
            this.sendTable(client, t.id, Number(msg.tableId), now);
          }
          break;
        }
        case "action":
          t.act(userId, parseAction(msg.action), now);
          break;
        case "back":
          t.setAway(userId, false);
          break;
        case "sitOut":
          t.setAway(userId, true);
          break;
        case "chat": {
          // Only at a table you're sitting at or watching.
          const tableId = Number(msg.tableId);
          const k = key(t.id, tableId);
          if (!client.subs.has(k) || !t.tables.has(tableId)) throw new TournamentError("Open the table to chat there");
          const seated = t.locate(userId)?.table.id === tableId;
          const m = this.chats.say(k, { ...client.user, userId, seated }, msg.text, now);
          this.sendChat(k, t.id, tableId, [m]);
          break;
        }
      }
    } catch (err) {
      if (err instanceof TournamentError || err instanceof ChatError) this.send(client, { type: "error", message: err.message });
      else {
        console.error("[ws] Error handling message:", err);
        this.send(client, { type: "error", message: "Something went wrong" });
      }
    }
  }

  // ------------------------------------------------------------ sending

  private subscribe(c: Client, k: string) {
    const isNew = !c.subs.has(k);
    c.subs.add(k);
    if (!this.watchers.has(k)) this.watchers.set(k, new Set());
    this.watchers.get(k)!.add(c);
    // Catch up on the table's recent chat.
    if (isNew) {
      const [tournamentId, tableId] = k.split(":").map(Number) as [number, number];
      this.send(c, { type: "chat", tournamentId, tableId, messages: this.chats.history(k), replace: true });
    }
  }

  private sendChat(k: string, tournamentId: number, tableId: number, messages: ChatMessage[]) {
    const data = JSON.stringify({ type: "chat", tournamentId, tableId, messages, replace: false } satisfies ServerMessage);
    for (const c of this.watchers.get(k) ?? []) this.sendRaw(c, data);
  }

  private unsubscribe(c: Client, k: string) {
    c.subs.delete(k);
    this.watchers.get(k)?.delete(c);
  }

  private flushTables() {
    this.flushQueued = false;
    const now = Date.now();
    for (const k of this.dirtyTables) {
      const [tid, tableId] = k.split(":").map(Number) as [number, number];
      const t = this.manager.get(tid);
      const watchers = this.watchers.get(k);
      if (!t || !watchers?.size) continue;
      const table = t.tables.get(tableId);
      if (!table) continue;
      const seated = new Set(table.seats.flatMap((s) => (s ? [s.userId] : [])));
      let spectatorJson: string | null = null;
      for (const c of watchers) {
        if (seated.has(c.user.id)) {
          const view = t.tableView(tableId, c.user.id, now);
          if (view) this.send(c, { type: "table", view });
        } else {
          spectatorJson ??= JSON.stringify({ type: "table", view: t.tableView(tableId, null, now) });
          this.sendRaw(c, spectatorJson);
        }
      }
    }
    this.dirtyTables.clear();
  }

  private sendTable(c: Client, tournamentId: number, tableId: number, now: number) {
    const view = this.manager.get(tournamentId)?.tableView(tableId, c.user.id, now);
    if (view) this.send(c, { type: "table", view });
  }

  private sendLobby(c: Client) {
    this.send(c, { type: "lobby", tournaments: this.manager.list(c.user.id), serverNow: Date.now() });
  }

  private send(c: Client, msg: ServerMessage) {
    this.sendRaw(c, JSON.stringify(msg));
  }

  private sendRaw(c: Client, data: string) {
    if (c.socket.readyState === c.socket.OPEN) c.socket.send(data);
  }

  private broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) this.sendRaw(c, data);
  }

  onlineCount() {
    return this.byUser.size;
  }
}

function parseAction(a: unknown): Action {
  const x = (a ?? {}) as { type?: unknown; to?: unknown };
  if (x.type === "fold" || x.type === "check" || x.type === "call") return { type: x.type };
  if (x.type === "raise" && typeof x.to === "number") return { type: "raise", to: x.to };
  throw new TournamentError("Invalid action");
}
