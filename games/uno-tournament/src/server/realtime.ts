import type { FastifyInstance } from "fastify";
import { COLORS, isCard } from "../shared/engine/cards.ts";
import type { ChatChannel, ChatMessage, ClientAction, ClientMessage, Color, FollowInfo, ServerMessage, TableView } from "../shared/protocol.ts";
import { type PublicUser, publicUser, userFromRequest } from "./auth.ts";
import { ChatError, TableChats, chatRights, defaultChannel } from "./chat.ts";
import { recordIp } from "./db.ts";
import { FollowBook, autoFollowers } from "./follow.ts";
import type { Notifier, TournamentManager } from "./tournament/manager.ts";
import { type Tournament, TournamentError } from "./tournament/tournament.ts";

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
const VIEWERS_THROTTLE_MS = 3000;
const MAX_MESSAGES_PER_SECOND = 20;

/** People watching a table who aren't seated at it, counting each person once however many tabs they have open. */
export function countViewers(watchers: Iterable<{ user: { id: number } }>, seated: Set<number>): number {
  const ids = new Set<number>();
  for (const w of watchers) if (!seated.has(w.user.id)) ids.add(w.user.id);
  return ids.size;
}

const seatedAt = (t: Tournament, tableId: number) =>
  new Set(t.tables.get(tableId)?.seats.flatMap((s) => (s ? [s.userId] : [])) ?? []);

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]!);
}

/**
 * WebSocket hub. Sends the lobby to everyone, and table updates to the players seated at that table
 * (each with only their own cards) plus any spectators: hidden cards for everyone, except admins
 * who aren't playing, who see every hand (host view).
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
  private viewersDirty = new Set<string>();
  private viewersTimer: ReturnType<typeof setTimeout> | null = null;
  private lastViewers = new Map<string, number>();
  readonly chats = new TableChats();
  readonly follows = new FollowBook();

  // ------------------------------------------------------------ Notifier

  tableNews(tournamentId: number, tableId: number, lines: string[]) {
    const k = key(tournamentId, tableId);
    const now = Date.now();
    const messages = lines.map((l) => this.chats.dealer(k, l, now));
    if (messages.length) this.sendChat(k, tournamentId, tableId, "table", messages);
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

  tableClosed(tournamentId: number, tableId: number, winnerId: number | null) {
    const k = key(tournamentId, tableId);
    const watcherIds = new Set<number>();
    for (const c of this.watchers.get(k) ?? []) {
      watcherIds.add(c.user.id);
      c.subs.delete(k);
      if (c.spectating === k) c.spectating = null;
      this.send(c, { type: "tableClosed", tournamentId, tableId });
    }
    this.watchers.delete(k);
    this.dirtyTables.delete(k);
    this.viewersDirty.delete(k);
    this.lastViewers.delete(k);
    this.chats.drop(k);

    const t = this.manager.get(tournamentId);
    if (!t || t.meta.status !== "running") {
      for (const f of this.follows.dropTournament(tournamentId)) this.sendFollow(f, tournamentId, "The tournament is over.");
      return;
    }
    // People who were watching follow the winner on to their next table.
    const auto = autoFollowers(watcherIds, winnerId, (id) => t.isStillPlaying(id), (id) => this.follows.target(tournamentId, id) !== null);
    for (const f of auto) {
      this.follows.follow(tournamentId, f, winnerId!);
      this.sendFollow(f, tournamentId, `This table is over. Now following the winner, ${this.nameOf(t, winnerId!)}.`);
    }
  }

  viewerCount(tournamentId: number, tableId: number) {
    const t = this.manager.get(tournamentId);
    if (!t?.tables.has(tableId)) return 0;
    return countViewers(this.watchers.get(key(tournamentId, tableId)) ?? [], seatedAt(t, tableId));
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
    const k = key(tournamentId, tableId);
    for (const c of this.byUser.get(userId) ?? []) {
      // Drop the old own-table subscription for this tournament.
      for (const old of [...c.subs]) if (old.startsWith(`${tournamentId}:`) && old !== c.spectating) this.unsubscribe(c, old);
      if (c.spectating === k) c.spectating = null;
      this.subscribe(c, k);
      this.send(c, { type: "moved", tournamentId, tableId });
    }
    this.tableChanged(tournamentId, tableId);
    // Sitting down always wins over following someone.
    if (this.follows.unfollow(tournamentId, userId) !== null) this.sendFollow(userId, tournamentId, null);
    const t = this.manager.get(tournamentId);
    if (!t) return;
    for (const f of this.follows.followers(tournamentId, userId)) this.sendFollow(f, tournamentId, `${this.nameOf(t, userId)} moved to table ${tableId}.`);
  }

  playerAdvanced(tournamentId: number, userId: number, round: number, totalRounds: number) {
    for (const c of this.byUser.get(userId) ?? []) this.send(c, { type: "advanced", tournamentId, round, totalRounds });
    this.lobbyChanged();
    const t = this.manager.get(tournamentId);
    if (!t) return;
    const where = round === totalRounds ? "the final table" : `their round ${round} table`;
    for (const f of this.follows.followers(tournamentId, userId))
      this.sendFollow(f, tournamentId, `${this.nameOf(t, userId)} won their table. Waiting for ${where} to start.`);
  }

  playerFinished(tournamentId: number, userId: number, place: number) {
    const t = this.manager.get(tournamentId);
    for (const c of this.byUser.get(userId) ?? []) {
      this.send(c, { type: "finished", tournamentId, place });
      // Still looking at the table they were knocked out at: they're a spectator there now.
      for (const k of c.subs) {
        const [tid, tableId] = k.split(":").map(Number) as [number, number];
        if (tid !== tournamentId || !t?.tables.has(tableId)) continue;
        this.send(c, { type: "chat", tournamentId, tableId, channel: "spectators", messages: this.chats.history(k, "spectators"), replace: true });
        this.markViewers(k);
      }
    }
    if (!t) return;
    const name = this.nameOf(t, userId);
    for (const f of this.follows.release(tournamentId, userId))
      this.sendFollow(f, tournamentId, place === 1 ? `🏆 ${name} won the tournament!` : `${name} was knocked out (${ordinal(place)}). You're no longer following anyone.`);
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
      if (this.viewersTimer) clearTimeout(this.viewersTimer);
      for (const c of this.clients) c.socket.close(1001, "Server shutting down");
    });
  }

  /** A signed-in user's socket is ready. */
  connect(socket: SocketLike, user: PublicUser) {
    const client: Client = { socket, user, alive: true, subs: new Set(), spectating: null, budget: MAX_MESSAGES_PER_SECOND };
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
    // Who they're following, if anyone.
    for (const { tournamentId } of this.follows.forUser(user.id)) this.send(client, this.followMessage(user.id, tournamentId, null));
    if (!wasConnected) this.broadcast({ type: "online", count: this.byUser.size });

    socket.on("pong", () => (client.alive = true));
    socket.on("message", (raw) => this.onMessage(client, String(raw)));
    socket.on("close", () => this.onClose(client));
    return client;
  }

  private onClose(client: Client) {
    this.clients.delete(client);
    for (const k of client.subs) {
      this.watchers.get(k)?.delete(client);
      this.markViewers(k);
    }
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
          const tableId = msg.tableId === null ? null : Number(msg.tableId);
          const target = tableId !== null && t.tables.has(tableId) ? key(t.id, tableId) : null;
          const ownTable = t.locate(userId)?.table.id;
          const own = ownTable === undefined ? null : key(t.id, ownTable);
          // Only the table being looked at and the player's own seat (tables they were knocked out at linger otherwise).
          for (const k of [...client.subs]) if (k.startsWith(`${t.id}:`) && k !== target && k !== own) this.unsubscribe(client, k);
          client.spectating = target !== null && target !== own ? target : null;
          if (target !== null) {
            this.subscribe(client, target);
            this.sendTable(client, t, tableId!, now);
          }
          break;
        }
        case "action":
          t.act(userId, parseAction(msg.action), now);
          break;
        case "back":
          t.setAway(userId, false);
          break;
        case "chat": {
          // Only at a table you're sitting at or watching.
          const tableId = Number(msg.tableId);
          const k = key(t.id, tableId);
          if (!client.subs.has(k) || !t.tables.has(tableId)) throw new TournamentError("Open the table to chat there");
          const person = { seated: t.locate(userId)?.table.id === tableId, isAdmin: client.user.isAdmin };
          const channel: ChatChannel = msg.channel === "table" || msg.channel === "spectators" ? msg.channel : defaultChannel(person);
          const m = this.chats.say(k, channel, { ...client.user, userId, seated: person.seated }, msg.text, now);
          this.sendChat(k, t.id, tableId, channel, [m]);
          break;
        }
        case "follow": {
          if (msg.userId === null) {
            this.follows.unfollow(t.id, userId);
            this.sendFollow(userId, t.id, null);
            break;
          }
          const target = Number(msg.userId);
          if (t.meta.status !== "running") throw new TournamentError("You can follow players while the tournament is running");
          if (t.isStillPlaying(userId)) throw new TournamentError("You can't follow anyone while you're still playing");
          if (target === userId || !t.isStillPlaying(target)) throw new TournamentError("That player is out of the tournament");
          this.follows.follow(t.id, userId, target);
          this.sendFollow(userId, t.id, `Following ${this.nameOf(t, target)}. You'll go to each table they play at.`);
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
    if (!isNew) return;
    const [tournamentId, tableId] = k.split(":").map(Number) as [number, number];
    // Catch up on the table's recent chat: the spectator chat too, unless they're playing here.
    this.send(c, { type: "chat", tournamentId, tableId, channel: "table", messages: this.chats.history(k, "table"), replace: true });
    const t = this.manager.get(tournamentId);
    const seated = t ? seatedAt(t, tableId).has(c.user.id) : false;
    if (!seated) this.send(c, { type: "chat", tournamentId, tableId, channel: "spectators", messages: this.chats.history(k, "spectators"), replace: true });
    this.send(c, { type: "viewers", tournamentId, tableId, count: this.viewerCount(tournamentId, tableId) });
    this.markViewers(k);
  }

  private unsubscribe(c: Client, k: string) {
    c.subs.delete(k);
    this.watchers.get(k)?.delete(c);
    this.markViewers(k);
  }

  /** Sends chat messages to the watchers allowed to read that channel (never spectator chat to seated players). */
  private sendChat(k: string, tournamentId: number, tableId: number, channel: ChatChannel, messages: ChatMessage[]) {
    const t = this.manager.get(tournamentId);
    const seated = t ? seatedAt(t, tableId) : new Set<number>();
    const data = JSON.stringify({ type: "chat", tournamentId, tableId, channel, messages, replace: false } satisfies ServerMessage);
    for (const c of this.watchers.get(k) ?? [])
      if (chatRights({ seated: seated.has(c.user.id), isAdmin: c.user.isAdmin }).read.includes(channel)) this.sendRaw(c, data);
  }

  /** A table's viewer count changed (maybe): send it within a few seconds, if it really did. */
  private markViewers(k: string) {
    this.viewersDirty.add(k);
    if (this.viewersTimer) return;
    this.viewersTimer = setTimeout(() => this.flushViewers(), VIEWERS_THROTTLE_MS);
  }

  private flushViewers() {
    this.viewersTimer = null;
    for (const k of this.viewersDirty) {
      const [tournamentId, tableId] = k.split(":").map(Number) as [number, number];
      const count = this.viewerCount(tournamentId, tableId);
      if (this.lastViewers.get(k) === count) continue;
      this.lastViewers.set(k, count);
      const data = JSON.stringify({ type: "viewers", tournamentId, tableId, count } satisfies ServerMessage);
      for (const c of this.watchers.get(k) ?? []) this.sendRaw(c, data);
    }
    this.viewersDirty.clear();
  }

  /**
   * The one place that decides what a person sees of a table: their own cards if seated there, every
   * hand if they're an admin who isn't playing, otherwise no hidden cards at all.
   */
  private viewKind(c: Client, t: Tournament, seated: Set<number>): "own" | "host" | "spectator" {
    if (seated.has(c.user.id)) return "own";
    if (t.canSeeAllCards(c.user)) return "host";
    return "spectator";
  }

  private viewFor(kind: "own" | "host" | "spectator", c: Client, t: Tournament, tableId: number, now: number): TableView | null {
    if (kind === "own") return t.tableView(tableId, c.user.id, now);
    if (kind === "host") return t.hostView(tableId, c.user, now);
    return t.tableView(tableId, null, now);
  }

  private flushTables() {
    this.flushQueued = false;
    const now = Date.now();
    for (const k of this.dirtyTables) {
      const [tid, tableId] = k.split(":").map(Number) as [number, number];
      const t = this.manager.get(tid);
      const watchers = this.watchers.get(k);
      if (!t || !watchers?.size || !t.tables.has(tableId)) continue;
      const seated = seatedAt(t, tableId);
      // Shared views are built once per table. Kept apart so the host view can never go to a spectator.
      let spectatorJson: string | null = null;
      let hostJson: string | null = null;
      for (const c of watchers) {
        const kind = this.viewKind(c, t, seated);
        if (kind === "own") {
          const view = this.viewFor("own", c, t, tableId, now);
          if (view) this.send(c, { type: "table", view });
        } else if (kind === "host") {
          hostJson ??= JSON.stringify({ type: "table", view: this.viewFor("host", c, t, tableId, now) });
          this.sendRaw(c, hostJson);
        } else {
          spectatorJson ??= JSON.stringify({ type: "table", view: this.viewFor("spectator", c, t, tableId, now) });
          this.sendRaw(c, spectatorJson);
        }
      }
    }
    this.dirtyTables.clear();
  }

  private sendTable(c: Client, t: Tournament, tableId: number, now: number) {
    const view = this.viewFor(this.viewKind(c, t, seatedAt(t, tableId)), c, t, tableId, now);
    if (view) this.send(c, { type: "table", view });
  }

  private nameOf(t: Tournament, userId: number) {
    return t.meta.entrants[userId]?.username ?? "That player";
  }

  private followMessage(userId: number, tournamentId: number, notice: string | null): ServerMessage {
    const t = this.manager.get(tournamentId);
    const target = this.follows.target(tournamentId, userId);
    const e = target === null ? undefined : t?.meta.entrants[target];
    const following: FollowInfo | null =
      t && e ? { userId: e.userId, username: e.username, tableId: t.locate(e.userId)?.table.id ?? null, round: e.round } : null;
    return { type: "follow", tournamentId, following, notice };
  }

  private sendFollow(userId: number, tournamentId: number, notice: string | null) {
    const clients = this.byUser.get(userId);
    if (!clients?.size) return;
    const data = JSON.stringify(this.followMessage(userId, tournamentId, notice));
    for (const c of clients) this.sendRaw(c, data);
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

function parseAction(a: unknown): ClientAction {
  const x = (a ?? {}) as { type?: unknown; card?: unknown; color?: unknown; uno?: unknown; seat?: unknown };
  if (x.type === "draw" || x.type === "pass" || x.type === "uno") return { type: x.type };
  if (x.type === "catch" && Number.isInteger(x.seat)) return { type: "catch", seat: x.seat as number };
  if (x.type === "play" && isCard(x.card)) {
    const color = (COLORS as readonly unknown[]).includes(x.color) ? (x.color as Color) : undefined;
    return { type: "play", card: x.card, ...(color ? { color } : {}), uno: x.uno === true };
  }
  throw new TournamentError("Invalid action");
}
