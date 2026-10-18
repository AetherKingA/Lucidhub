import { useEffect, useRef, useState } from "react";
import type { GameInfo, GameRow, ServerState, ServerStatus } from "../shared/protocol.ts";
import { api, fmtAgo, useApi } from "./api.ts";
import { Empty, PageHeader, useAction, useHub } from "./ui.tsx";

export function GamesPage() {
  const { loaded, games, reload } = useHub();
  const [adding, setAdding] = useState(false);
  const servers = useApi<ServerStatus[]>("/api/servers", 3000);

  useEffect(() => {
    if (loaded && games.length === 0) setAdding(true);
  }, [loaded, games.length]);

  return (
    <>
      <PageHeader title="Games" sub="Every game site plugs into LucidHub with a shared secret. LucidHub can also run each game's server for you — start it with the hub and forget about it.">
        {!adding && (
          <button className="btn primary" onClick={() => setAdding(true)}>
            + Connect a game
          </button>
        )}
      </PageHeader>
      {adding && (
        <AddGame
          onDone={() => {
            setAdding(false);
            void reload();
          }}
        />
      )}
      {loaded && games.length === 0 && !adding ? (
        <Empty>No games connected.</Empty>
      ) : (
        games.map((g) => (
          <GameCard key={g.id} game={g} server={servers.data?.find((s) => s.gameId === g.id) ?? null} onServerChange={() => void servers.reload()} />
        ))
      )}
    </>
  );
}

function AddGame({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState("poker");
  const [name, setName] = useState("Poker Night");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:3000");
  const [launchDir, setLaunchDir] = useState("");
  const [launchCmd, setLaunchCmd] = useState("");
  const [autostart, setAutostart] = useState(true);
  const { busy, run } = useAction();

  // Poker Night sitting next to the hub is found automatically.
  useEffect(() => {
    void api<{ launchDir?: string; launchCmd?: string }>(`/api/games/suggest?key=${encodeURIComponent(key)}`).then((s) => {
      if (s.launchDir) setLaunchDir((v) => v || s.launchDir!);
      if (s.launchCmd) setLaunchCmd((v) => v || s.launchCmd!);
    });
  }, [key]);

  return (
    <section className="card panel">
      <h3>Connect a game</h3>
      <div className="form-grid">
        <label>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>Key (short id, used in the webhook address)</span>
          <input value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} />
        </label>
        <label className="wide">
          <span>Address LucidHub uses to reach the game (on this PC: http://127.0.0.1:port)</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
      </div>
      <LaunchFields dir={launchDir} cmd={launchCmd} autostart={autostart} onDir={setLaunchDir} onCmd={setLaunchCmd} onAutostart={setAutostart} />
      <div className="row end">
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const g = await api<GameRow>("/api/games", { body: { key, name, baseUrl, launchDir, launchCmd, autostart } });
              // Point the game at the hub straight away, so connecting is one click.
              if (g.launchDir) await api(`/api/games/${g.id}/write-env`, { body: {} }).catch(() => {});
              onDone();
            }, "Game connected")
          }
        >
          Connect
        </button>
      </div>
    </section>
  );
}

function LaunchFields(p: {
  dir: string;
  cmd: string;
  autostart: boolean;
  onDir: (v: string) => void;
  onCmd: (v: string) => void;
  onAutostart: (v: boolean) => void;
}) {
  return (
    <div className="launch">
      <h4>Run its server from LucidHub (optional)</h4>
      <div className="form-grid">
        <label className="wide">
          <span>Server folder (full path)</span>
          <input className="mono" value={p.dir} onChange={(e) => p.onDir(e.target.value)} placeholder="C:\…\poker-tournament" />
        </label>
        <label className="wide">
          <span>Start command, run in that folder</span>
          <input className="mono" value={p.cmd} onChange={(e) => p.onCmd(e.target.value)} placeholder="scripts\hub-start.cmd" />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={p.autostart} onChange={(e) => p.onAutostart(e.target.checked)} disabled={!p.dir} />
        Start it whenever LucidHub starts, and restart it if it crashes
      </label>
    </div>
  );
}

const STATE_LABEL: Record<ServerState, string> = {
  stopped: "Stopped",
  starting: "Starting…",
  running: "Running",
  stopping: "Stopping…",
  crashed: "Crashed",
};

function GameCard({ game, server, onServerChange }: { game: GameRow; server: ServerStatus | null; onServerChange: () => void }) {
  const { reload, toast } = useHub();
  const [secret, setSecret] = useState<string | null>(null);
  const [info, setInfo] = useState<GameInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const { busy, run } = useAction();
  const online = !game.lastError && game.lastOkAt;
  const hubUrl = game.webhookUrl.replace(/\/api\/games\/.*$/, "");
  const envLines = secret ? `HUB_URL=${hubUrl}\nHUB_SECRET=${secret}` : null;
  const managed = Boolean(game.launchDir && game.launchCmd);
  const state = server?.state ?? "stopped";
  const live = state === "starting" || state === "running" || state === "stopping";

  const control = (action: "start" | "stop" | "restart", label: string) =>
    run(async () => {
      await api(`/api/games/${game.id}/server/${action}`, { body: {} });
      onServerChange();
      if (action !== "stop") setShowLog(true);
      void reload();
    }, label);

  return (
    <section className="card">
      <div className="row between">
        <div>
          <h3>
            {game.name} <span className="muted small mono">{game.key}</span>
          </h3>
          <p className="muted small">
            {game.baseUrl} ·{" "}
            {!game.enabled ? (
              <span className="muted">Disabled</span>
            ) : online ? (
              <span className="ok">Connected (checked {fmtAgo(game.lastOkAt)})</span>
            ) : game.lastError ? (
              <span className="bad">{game.lastError}</span>
            ) : (
              <span className="warn">Not checked yet</span>
            )}
          </p>
        </div>
        <div className="row">
          <button
            className="btn ghost small-btn"
            disabled={busy}
            onClick={() =>
              run(async () => {
                setInfo(await api<GameInfo>(`/api/games/${game.id}/info`));
                await reload();
              }, "Connection works")
            }
          >
            Test connection
          </button>
          <button className="btn ghost small-btn" onClick={() => run(async () => setSecret(secret ? null : (await api<{ secret: string }>(`/api/games/${game.id}/secret`)).secret))}>
            {secret ? "Hide setup" : "Show setup"}
          </button>
          <button className="link" onClick={() => run(async () => { await api(`/api/games/${game.id}`, { method: "PATCH", body: { enabled: !game.enabled } }); await reload(); })}>
            {game.enabled ? "Disable" : "Enable"}
          </button>
        </div>
      </div>

      {envLines && (
        <div className="setup-box">
          <p className="small">
            The game needs these two lines in its <code>.env</code>.{" "}
            {managed ? "LucidHub can write them for you — then restart the server." : "Paste them in, then restart the game."} Keep the secret private.
          </p>
          <pre className="mono">{envLines}</pre>
          <div className="row">
            <button className="btn ghost small-btn" onClick={() => void navigator.clipboard.writeText(envLines).then(() => toast("Copied"))}>
              Copy
            </button>
            {managed && (
              <button className="btn ghost small-btn" disabled={busy} onClick={() => run(() => api(`/api/games/${game.id}/write-env`, { body: {} }), "Saved to the game's .env")}>
                Write to {game.name}'s .env
              </button>
            )}
          </div>
        </div>
      )}
      {info && <p className="muted small">Game reports: {info.name}, {info.fields.length} event options.</p>}

      <div className="server">
        <div className="row between">
          <div className="row">
            <strong>Server</strong>
            {managed ? (
              <>
                <span className={`pill srv-${state}`}>{STATE_LABEL[state]}</span>
                {live && server?.startedAt && <span className="muted small">up {fmtAgo(server.startedAt).replace(" ago", "")}</span>}
                {game.autostart && <span className="muted small">· starts with LucidHub</span>}
              </>
            ) : (
              <span className="muted small">Not run by LucidHub — start it yourself (e.g. its start.bat).</span>
            )}
          </div>
          <div className="row">
            {managed && !live && (
              <button className="btn primary small-btn" disabled={busy} onClick={() => control("start", `Starting ${game.name}`)}>
                Start
              </button>
            )}
            {managed && live && (
              <>
                <button className="btn ghost small-btn" disabled={busy || state === "stopping"} onClick={() => control("restart", "Restarted")}>
                  Restart
                </button>
                <button
                  className="btn danger small-btn"
                  disabled={busy || state === "stopping"}
                  onClick={() => confirm(`Stop ${game.name}? Running tournaments are saved and come back paused.`) && control("stop", "Stopped")}
                >
                  Stop
                </button>
              </>
            )}
            {managed && (
              <button className="link" onClick={() => setShowLog(!showLog)}>
                {showLog ? "Hide log" : "Log"}
              </button>
            )}
            <button className="link" onClick={() => setEditing(!editing)}>
              {editing ? "Close" : managed ? "Settings" : "Set up"}
            </button>
          </div>
        </div>
        {server?.message && <p className={`small ${state === "crashed" ? "bad" : "warn"}`}>{server.message}</p>}
        {editing && <LaunchEditor game={game} onDone={() => { setEditing(false); void reload(); }} />}
        {showLog && managed && <ServerLog gameId={game.id} />}
      </div>
    </section>
  );
}

function LaunchEditor({ game, onDone }: { game: GameRow; onDone: () => void }) {
  const [dir, setDir] = useState(game.launchDir ?? "");
  const [cmd, setCmd] = useState(game.launchCmd ?? "");
  const [autostart, setAutostart] = useState(game.launchDir ? game.autostart : true);
  const { busy, run } = useAction();

  useEffect(() => {
    if (game.launchDir) return;
    void api<{ launchDir?: string; launchCmd?: string }>(`/api/games/suggest?key=${encodeURIComponent(game.key)}`).then((s) => {
      if (s.launchDir) setDir((v) => v || s.launchDir!);
      if (s.launchCmd) setCmd((v) => v || s.launchCmd!);
    });
  }, [game.key, game.launchDir]);

  return (
    <div className="setup-box">
      <LaunchFields dir={dir} cmd={cmd} autostart={autostart} onDir={setDir} onCmd={setCmd} onAutostart={setAutostart} />
      <div className="row end">
        {game.launchDir && (
          <button
            className="link danger"
            onClick={() => run(async () => { await api(`/api/games/${game.id}`, { method: "PATCH", body: { launchDir: null, launchCmd: null, autostart: false } }); onDone(); }, "LucidHub won't run this server any more")}
          >
            Stop running it from LucidHub
          </button>
        )}
        <button className="btn primary small-btn" disabled={busy} onClick={() => run(async () => { await api(`/api/games/${game.id}`, { method: "PATCH", body: { launchDir: dir, launchCmd: cmd, autostart } }); onDone(); }, "Saved")}>
          Save
        </button>
      </div>
    </div>
  );
}

function ServerLog({ gameId }: { gameId: number }) {
  const { data } = useApi<{ lines: string[] }>(`/api/games/${gameId}/server/logs`, 2000);
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [data]);
  return (
    <pre
      ref={box}
      className="log mono"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      }}
    >
      {data?.lines.length ? data.lines.join("\n") : "Nothing logged yet."}
    </pre>
  );
}
