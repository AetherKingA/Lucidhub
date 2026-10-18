// Runs game servers (Poker Night, later chess…) as background processes of the hub, so starting the
// hub starts everything. Each game with a launch folder + command can be started, stopped and
// restarted from the dashboard; games set to start with the hub are restarted if they crash.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ServerState, ServerStatus } from "../shared/protocol.ts";
import { raiseAlert } from "./alerts.ts";
import { ROOT, config } from "./config.ts";
import { audit } from "./db.ts";
import { type Game, GameRequestError, gameClient, getGame, listGames, localPort } from "./games.ts";
import { syncGame } from "./sync.ts";
import { closeFunnel, openFunnel } from "./tailscale.ts";

const LOG_LINES = 400;
/** How long a game gets to save and exit after the hub asks it to, before it's force-stopped. */
const GRACEFUL_STOP_MS = 15_000;
/** How long after starting the hub keeps checking whether the game answers. */
const READY_TIMEOUT_MS = 3 * 60_000;
const RESTART_WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS = 5;

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * The hub's own settings (from its .env). A game must not inherit them: environment variables win over
 * the game's own .env, so it would use the hub's port and database, and see the bot token.
 */
const HUB_ONLY_ENV = [
  "PORT",
  "PUBLIC_URL",
  "DB_PATH",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_BOT_TOKEN",
  "ADMIN_DISCORD_IDS",
  "SESSION_DAYS",
  "KEEP_AWAKE",
  "OPEN_DASHBOARD",
];

export function gameEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, FORCE_COLOR: "0", NO_COLOR: "1" };
  for (const key of HUB_ONLY_ENV) delete env[key];
  return env;
}

/** Each game keeps its data under the hub's data folder, so one folder holds everything to back up. */
const gameDataDir = (key: string) => resolve(config.dbPath === ":memory:" ? resolve(ROOT, "data") : dirname(config.dbPath), "games", key);

/**
 * Everything a game server needs, handed over by the hub, so games have no settings file of their own
 * (INTEGRATION.md lists these). Players sign in with the same Discord application as the dashboard.
 */
export function gameEnvFor(game: Game, publicUrl: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...gameEnv(base),
    PORT: String(localPort(game)),
    PUBLIC_URL: publicUrl,
    DISCORD_CLIENT_ID: config.discord.clientId,
    DISCORD_CLIENT_SECRET: config.discord.clientSecret,
    ADMIN_DISCORD_IDS: [...config.adminDiscordIds].join(","),
    HUB_URL: `http://127.0.0.1:${config.port}`,
    HUB_SECRET: game.secret,
    DB_PATH: resolve(gameDataDir(game.key), `${game.key}.db`),
    // The hub keeps the PC awake while it runs.
    KEEP_AWAKE: "false",
  };
}

interface Managed {
  child: ChildProcess | null;
  state: ServerState;
  startedAt: number | null;
  exitCode: number | null;
  ready: boolean;
  message: string | null;
  /** True while the hub wants it running; a process that exits while this is true crashed. */
  wanted: boolean;
  restarts: number[];
  restartTimer: ReturnType<typeof setTimeout> | null;
  log: string[];
  logFile: WriteStream | null;
  exited: Promise<void> | null;
  /** Running, but not started by this hub (its own start.bat, or left over after the hub was killed). */
  external: boolean;
  /** Where players reach it; the Funnel address when public. */
  publicUrl: string | null;
  /** Tailscale's one-time approval link, when it asked for one. */
  approveUrl: string | null;
  /** The Funnel this hub opened for it (closed again when it stops). */
  funnelPort: number | null;
}

export class ProcessManager {
  private servers = new Map<number, Managed>();
  private logDir: string;
  /** Wait before the Nth crash restart is N × this. */
  private restartDelayMs: number;

  constructor(opts: { logDir?: string | null; restartDelayMs?: number } = {}) {
    this.logDir = opts.logDir !== undefined ? (opts.logDir ?? "") : config.dbPath === ":memory:" ? "" : resolve(dirname(config.dbPath), "logs");
    this.restartDelayMs = opts.restartDelayMs ?? 3000;
  }

  private entry(gameId: number): Managed {
    let m = this.servers.get(gameId);
    if (!m) {
      m = { child: null, state: "stopped", startedAt: null, exitCode: null, ready: false, message: null, wanted: false, restarts: [], restartTimer: null, log: [], logFile: null, exited: null, external: false, publicUrl: null, approveUrl: null, funnelPort: null };
      this.servers.set(gameId, m);
    }
    return m;
  }

  status(gameId: number): ServerStatus {
    const m = this.entry(gameId);
    const now = Date.now();
    return {
      gameId,
      state: m.state,
      pid: m.child?.pid ?? null,
      startedAt: m.startedAt,
      ready: m.ready,
      exitCode: m.exitCode,
      recentRestarts: m.restarts.filter((t) => now - t < RESTART_WINDOW_MS).length,
      message: m.message,
      publicUrl: m.publicUrl,
      approveUrl: m.approveUrl,
    };
  }

  logs(gameId: number): string[] {
    return this.entry(gameId).log;
  }

  /** Starts every game marked "start with the hub". */
  async startAutostart() {
    for (const g of listGames()) {
      if (g.enabled && g.autostart && g.launchDir && g.launchCmd) {
        try {
          await this.start(g.id, "system");
        } catch (err) {
          raiseAlert(`start:${g.id}`, `Couldn't start **${g.name}**: ${(err as Error).message}`);
        }
      }
    }
  }

  async start(gameId: number, actor: string) {
    const game = getGame(gameId);
    if (!game) throw new ServerControlError("Game not found");
    if (!game.launchDir || !game.launchCmd) throw new ServerControlError(`Set ${game.name}'s server folder and start command first`);
    const m = this.entry(gameId);
    if (m.child) throw new ServerControlError(`${game.name} is already running`);
    // Already up (its own start.bat, or left over after the hub was killed)? A second copy would fight
    // over the port, so take this one over: Stop and Restart still work through its shutdown route.
    if (await answers(game)) {
      m.external = true;
      m.state = "running";
      m.ready = true;
      m.startedAt ??= Date.now();
      m.message = "Was already running when LucidHub started it, so LucidHub took it over. Its log shows only what LucidHub runs.";
      this.append(m, `--- ${game.name} was already running; LucidHub took it over ---`);
      void syncGame(game);
      return;
    }
    m.external = false;
    if (m.restartTimer) clearTimeout(m.restartTimer);
    m.restartTimer = null;
    m.wanted = true;
    this.openLog(game, m);
    await this.openPublicAccess(game, m);
    this.spawn(game, m);
    audit(actor, "server started", game.name);
  }

  /** Opens the Funnel for a public game. Problems don't stop the game; it just stays local-only. */
  private async openPublicAccess(game: Game, m: Managed) {
    const local = `http://localhost:${localPort(game)}`;
    m.approveUrl = null;
    if (!game.publicAccess) {
      m.publicUrl = local;
      return;
    }
    this.append(m, `--- Opening Tailscale Funnel on public port ${game.funnelPort} ---`);
    const r = await openFunnel(localPort(game), game.funnelPort);
    if (r.ok) {
      m.publicUrl = r.url;
      m.funnelPort = game.funnelPort;
      this.append(m, `--- Players can reach ${game.name} at ${r.url} ---`);
      return;
    }
    // Keep the public address when it's known, so the Discord redirect stays right once Funnel works.
    m.publicUrl = r.url ?? local;
    m.approveUrl = r.approveUrl ?? null;
    this.append(m, `--- ${r.reason}${r.approveUrl ? ` Approve it here, then restart: ${r.approveUrl}` : ""} ---`);
    raiseAlert(
      `funnel:${game.id}`,
      `**${game.name}** is running, but players can't reach it yet: ${r.reason}${r.approveUrl ? ` Approve it here, then press Restart in LucidHub: ${r.approveUrl}` : ""}`,
    );
  }

  private async closePublicAccess(m: Managed) {
    if (m.funnelPort === null) return;
    const port = m.funnelPort;
    m.funnelPort = null;
    await closeFunnel(port).catch(() => {});
    this.append(m, `--- Closed Tailscale Funnel on public port ${port} ---`);
  }

  private spawn(game: Game, m: Managed) {
    m.state = "starting";
    m.ready = false;
    m.exitCode = null;
    m.message = null;
    m.startedAt = Date.now();
    this.openLog(game, m);
    this.append(m, `--- Starting ${game.name}: ${game.launchCmd} (in ${game.launchDir}) ---`);

    const env = gameEnvFor(game, m.publicUrl ?? `http://localhost:${localPort(game)}`);
    const isWin = process.platform === "win32";
    const child = isWin
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${game.launchCmd}"`], {
          cwd: game.launchDir!,
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio: ["ignore", "pipe", "pipe"],
          env,
        })
      : spawn("sh", ["-c", game.launchCmd!], { cwd: game.launchDir!, stdio: ["ignore", "pipe", "pipe"], env });
    m.child = child;

    let pending = "";
    const onData = (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) this.append(m, line.replace(ANSI, ""));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    m.exited = new Promise((done) => {
      const finish = (code: number | null, error?: Error) => {
        if (pending) this.append(m, pending.replace(ANSI, ""));
        pending = "";
        if (m.child !== child) return done();
        m.child = null;
        m.exitCode = code;
        m.ready = false;
        if (error) this.append(m, `--- Could not start: ${error.message} ---`);
        else this.append(m, `--- ${game.name} exited (code ${code ?? "?"}) ---`);
        if (m.wanted) this.onCrash(game.id, m, error?.message ?? `exited with code ${code ?? "?"}`);
        else m.state = "stopped";
        done();
      };
      child.once("error", (err) => finish(null, err));
      child.once("exit", (code) => finish(code));
    });

    void this.watchReady(game, m, child);
  }

  /** Marks the server running once the game answers, then syncs its events. */
  private async watchReady(game: Game, m: Managed, child: ChildProcess) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (m.child === child && Date.now() < deadline) {
      if (await answers(game)) {
        if (m.child !== child) return;
        m.state = "running";
        m.ready = true;
        this.append(m, `--- ${game.name} is up and talking to LucidHub ---`);
        void syncGame(getGame(game.id) ?? game);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (m.child === child) {
      m.state = "running";
      m.message = `Started, but ${game.name} isn't answering the hub. Check its log and HUB_SECRET.`;
    }
  }

  private onCrash(gameId: number, m: Managed, reason: string) {
    const game = getGame(gameId);
    const name = game?.name ?? `Game ${gameId}`;
    const now = Date.now();
    m.restarts = m.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    m.state = "crashed";
    if (!game?.autostart || !game.enabled) {
      m.wanted = false;
      m.message = `Stopped unexpectedly (${reason}).`;
      raiseAlert(`crash:${gameId}`, `**${name}** stopped unexpectedly (${reason}). Start it again from the dashboard.`);
      return;
    }
    if (m.restarts.length >= MAX_RESTARTS) {
      m.wanted = false;
      m.message = `Crashed ${MAX_RESTARTS} times in 10 minutes, so LucidHub stopped restarting it. Check the log.`;
      raiseAlert(`crashloop:${gameId}`, `**${name}** keeps crashing (${reason}). LucidHub stopped restarting it — check its log in the dashboard.`);
      return;
    }
    m.restarts.push(now);
    const delay = this.restartDelayMs * m.restarts.length;
    m.message = `Crashed (${reason}). Restarting in ${delay / 1000}s…`;
    audit("system", "server crashed", `${name}: ${reason}, restarting`);
    m.restartTimer = setTimeout(() => {
      m.restartTimer = null;
      const g = getGame(gameId);
      if (m.wanted && !m.child && g) this.spawn(g, m);
    }, delay);
  }

  /** Asks the game to save and exit; force-stops it if it doesn't within GRACEFUL_STOP_MS. */
  async stop(gameId: number, actor: string) {
    const m = this.entry(gameId);
    const game = getGame(gameId);
    m.wanted = false;
    if (m.restartTimer) clearTimeout(m.restartTimer);
    m.restartTimer = null;
    const child = m.child;
    if (!child) {
      if (m.external && game) await this.stopExternal(game, m, actor);
      await this.closePublicAccess(m);
      m.state = "stopped";
      return;
    }
    m.state = "stopping";
    if (game) this.append(m, "--- Stopping ---");
    let asked = false;
    if (game) {
      try {
        await gameClient.shutdown(game);
        asked = true;
      } catch (err) {
        if (!(err instanceof GameRequestError)) throw err;
      }
    }
    const exited = m.exited ?? Promise.resolve();
    const inTime = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), asked ? GRACEFUL_STOP_MS : 0))]);
    if (!inTime) {
      if (game) this.append(m, "--- Didn't stop by itself; force-stopping ---");
      killTree(child);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
    await this.closePublicAccess(m);
    m.state = "stopped";
    m.ready = false;
    if (game) audit(actor, "server stopped", game.name);
  }

  /** Stops a copy the hub didn't start, by asking it over the integration API. */
  private async stopExternal(game: Game, m: Managed, actor: string) {
    m.state = "stopping";
    this.append(m, "--- Asking the running copy to stop ---");
    try {
      await gameClient.shutdown(game);
    } catch (err) {
      m.state = "running";
      throw new ServerControlError(`${game.name} wasn't started by LucidHub and didn't accept a stop request (${(err as Error).message}). Close its own window instead.`);
    }
    const deadline = Date.now() + GRACEFUL_STOP_MS;
    while (Date.now() < deadline && (await answers(game))) await new Promise((r) => setTimeout(r, 500));
    m.external = false;
    m.ready = false;
    m.message = null;
    audit(actor, "server stopped", game.name);
  }

  async restart(gameId: number, actor: string) {
    await this.stop(gameId, actor);
    await this.start(gameId, actor);
  }

  /** Stops every server the hub started (when the hub shuts down). */
  async stopAll() {
    await Promise.all([...this.servers.entries()].filter(([, m]) => m.child).map(([id]) => this.stop(id, "system").catch(() => {})));
    for (const m of this.servers.values()) m.logFile?.end();
  }

  private openLog(game: Game, m: Managed) {
    if (!this.logDir || m.logFile) return;
    try {
      mkdirSync(this.logDir, { recursive: true });
      m.logFile = createWriteStream(resolve(this.logDir, `${game.key}.log`), { flags: "a" });
      m.logFile.on("error", () => (m.logFile = null));
    } catch {
      m.logFile = null;
    }
  }

  private append(m: Managed, line: string) {
    if (!line.trim()) return;
    const stamped = `${new Date().toLocaleTimeString()}  ${line}`;
    m.log.push(stamped);
    if (m.log.length > LOG_LINES) m.log.splice(0, m.log.length - LOG_LINES);
    m.logFile?.write(stamped + "\n");
  }
}

export class ServerControlError extends Error {}

/** True if anything answers at the game's address (502 is how the client reports "nothing is listening"). */
async function answers(game: Game) {
  try {
    await gameClient.info(game);
    return true;
  } catch (err) {
    return err instanceof GameRequestError && err.status !== 502;
  }
}

/** Ends a process and everything it started (npm, node…). */
function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill("SIGKILL");
}

