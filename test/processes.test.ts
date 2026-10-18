import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addGame, updateGame } from "../src/server/games.ts";
import { ProcessManager } from "../src/server/processes.ts";

// A stand-in game server: answers the integration API (and its shutdown route) on a free port.
const GAME = `
const http = require("node:http");
const port = Number(process.argv[2]);
const mode = process.argv[3];
console.log("fake game booting on " + port);
if (mode === "crash") { setTimeout(() => process.exit(3), 300); }
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/integration/shutdown") { res.end('{"ok":true}'); console.log("saving and exiting"); setTimeout(() => process.exit(0), 50); return; }
  if (req.url.startsWith("/api/integration/events")) return res.end("[]");
  res.end(JSON.stringify({ key: "fake", name: "Fake", fields: [] }));
});
if (mode !== "deaf") server.listen(port, "127.0.0.1");
else setInterval(() => {}, 1000);
`;

const dir = mkdtempSync(join(tmpdir(), "hub-proc-"));
writeFileSync(join(dir, "game.cjs"), GAME);

async function freePort() {
  return new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

let n = 0;
async function makeGame(mode = "ok", autostart = false) {
  const port = await freePort();
  return addGame({
    key: `proc${++n}`,
    name: `Proc ${n}`,
    baseUrl: `http://127.0.0.1:${port}`,
    launchDir: dir,
    launchCmd: `node game.cjs ${port} ${mode}`,
    autostart,
  });
}

async function waitFor(check: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const managers: ProcessManager[] = [];
const manager = () => {
  const m = new ProcessManager({ restartDelayMs: 200 });
  managers.push(m);
  return m;
};
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stopAll()));
});

describe("ProcessManager", { timeout: 40_000 }, () => {
  it("starts a game server, notices when it answers, and stops it gracefully", async () => {
    const pm = manager();
    const g = await makeGame();
    await pm.start(g.id, "test");
    await waitFor(() => pm.status(g.id).ready);
    expect(pm.status(g.id)).toMatchObject({ state: "running", ready: true });
    expect(pm.logs(g.id).some((l) => l.includes("fake game booting"))).toBe(true);
    await pm.stop(g.id, "test");
    expect(pm.status(g.id).state).toBe("stopped");
    expect(pm.logs(g.id).some((l) => l.includes("saving and exiting"))).toBe(true);
  });

  it("force-stops a server that doesn't answer", async () => {
    const pm = manager();
    const g = await makeGame("deaf");
    await pm.start(g.id, "test");
    await waitFor(() => pm.status(g.id).pid !== null);
    await pm.stop(g.id, "test");
    expect(pm.status(g.id)).toMatchObject({ state: "stopped", pid: null });
  });

  it("takes over a copy that is already running instead of starting a second one, and can still stop it", async () => {
    const first = manager();
    const g = await makeGame();
    await first.start(g.id, "test");
    await waitFor(() => first.status(g.id).ready);
    // A new hub (e.g. after the old one was killed) finds the server already up.
    const second = manager();
    await second.start(g.id, "test");
    expect(second.status(g.id)).toMatchObject({ state: "running", ready: true, pid: null });
    expect(second.status(g.id).message).toMatch(/took it over/);
    await second.stop(g.id, "test");
    expect(second.status(g.id).state).toBe("stopped");
    await waitFor(() => first.status(g.id).state !== "running");
  });

  it("restarts a crashed autostart server, and gives up after repeated crashes", async () => {
    const pm = manager();
    const g = await makeGame("crash", true);
    await pm.start(g.id, "test");
    await waitFor(() => pm.status(g.id).recentRestarts >= 1);
    expect(pm.status(g.id).message).toMatch(/Restarting|Crashed/);
    await waitFor(() => pm.status(g.id).message?.includes("stopped restarting") ?? false, 35_000);
    expect(pm.status(g.id).state).toBe("crashed");
  });

  it("doesn't restart a crashed server that isn't set to start with the hub", async () => {
    const pm = manager();
    const g = await makeGame("crash", false);
    await pm.start(g.id, "test");
    await waitFor(() => pm.status(g.id).state === "crashed");
    await new Promise((r) => setTimeout(r, 4000));
    expect(pm.status(g.id).recentRestarts).toBe(0);
    expect(pm.status(g.id).message).toMatch(/Start it again|unexpectedly/);
  });

  it("starts only games marked to start with the hub", async () => {
    const pm = manager();
    const auto = await makeGame("ok", true);
    const manual = await makeGame("ok", false);
    await pm.startAutostart();
    await waitFor(() => pm.status(auto.id).ready);
    expect(pm.status(manual.id).state).toBe("stopped");
    updateGame(auto.id, { autostart: false });
  });

  it("validates launch settings", () => {
    expect(() => addGame({ key: "badlaunch", name: "x", baseUrl: "http://127.0.0.1:1", launchDir: "relative/path", launchCmd: "x" })).toThrow(/full path/);
    expect(() => addGame({ key: "badlaunch2", name: "x", baseUrl: "http://127.0.0.1:1", launchDir: dir })).toThrow(/both/);
  });
});

describe("writeGameEnv", () => {
  it("sets HUB_URL and HUB_SECRET, keeping the rest of the file and its line endings", async () => {
    const { writeGameEnv } = await import("../src/server/games.ts");
    const { readFileSync } = await import("node:fs");
    const gameDir = mkdtempSync(join(tmpdir(), "hub-env-"));
    writeFileSync(join(gameDir, ".env"), "PUBLIC_URL=https://x\r\nHUB_SECRET=old\r\n# keep me\r\n");
    const g = addGame({ key: "envgame", name: "Env", baseUrl: "http://127.0.0.1:1", secret: "newsecret", launchDir: gameDir, launchCmd: "x" });
    expect(writeGameEnv(g.id).created).toBe(false);
    const text = readFileSync(join(gameDir, ".env"), "utf8");
    expect(text).toContain("PUBLIC_URL=https://x\r\nHUB_SECRET=newsecret\r\n# keep me\r\n");
    expect(text).toMatch(/HUB_URL=http:\/\/127\.0\.0\.1:\d+\r\n$/);
    expect(text).not.toContain("old");
    // Running it again changes nothing.
    writeGameEnv(g.id);
    expect(readFileSync(join(gameDir, ".env"), "utf8")).toBe(text);
  });

  it("creates the .env from .env.example when there isn't one", async () => {
    const { writeGameEnv } = await import("../src/server/games.ts");
    const { readFileSync } = await import("node:fs");
    const gameDir = mkdtempSync(join(tmpdir(), "hub-env-"));
    writeFileSync(join(gameDir, ".env.example"), "DISCORD_CLIENT_ID=\n");
    const g = addGame({ key: "envgame2", name: "Env2", baseUrl: "http://127.0.0.1:1", secret: "s2", launchDir: gameDir, launchCmd: "x" });
    expect(writeGameEnv(g.id).created).toBe(true);
    expect(readFileSync(join(gameDir, ".env"), "utf8")).toMatch(/^DISCORD_CLIENT_ID=\n\n# LucidHub connection.*\nHUB_URL=.*\nHUB_SECRET=s2\n$/);
  });
});

describe("gameEnv", () => {
  it("keeps the hub's own settings and secrets away from game servers", async () => {
    const { gameEnv } = await import("../src/server/processes.ts");
    const env = gameEnv({ PATH: "/bin", PORT: "3100", DB_PATH: "hub.db", DISCORD_BOT_TOKEN: "secret", PUBLIC_URL: "http://localhost:3100", SystemRoot: "C:\Windows" });
    expect(env).toMatchObject({ PATH: "/bin", SystemRoot: "C:\Windows" });
    for (const k of ["PORT", "DB_PATH", "DISCORD_BOT_TOKEN", "PUBLIC_URL"]) expect(env[k]).toBeUndefined();
  });
});

describe("windowsProgramPath", () => {
  it("turns forward slashes in the program path into backslashes on Windows only", async () => {
    const { windowsProgramPath } = await import("../src/server/games.ts");
    expect(windowsProgramPath("scripts/hub-start.cmd --x a/b", "win32")).toBe("scripts\\hub-start.cmd --x a/b");
    expect(windowsProgramPath('"C:/Program Files/x.exe" y', "win32")).toBe('"C:\\Program Files\\x.exe" y');
    expect(windowsProgramPath("npm start", "win32")).toBe("npm start");
    expect(windowsProgramPath("scripts/run.sh", "linux")).toBe("scripts/run.sh");
  });
});
