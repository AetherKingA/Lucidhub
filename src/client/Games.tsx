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
      <PageHeader title="Games" sub="Your games run from LucidHub: it starts their servers, hands them their settings, opens them to players, and pays out their winners.">
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

// ---------------------------------------------------------------- launch settings

interface Launch {
  launchDir: string;
  launchCmd: string;
  autostart: boolean;
  publicAccess: boolean;
  funnelPort: number;
}

type Suggestion = { name?: string; baseUrl?: string; launchDir?: string; launchCmd?: string; publicAccess?: boolean; funnelPort?: number };

/** Fills in the settings for a game LucidHub knows (one in its games/ folder). */
function useSuggestion(key: string, skip: boolean, apply: (s: Suggestion) => void) {
  useEffect(() => {
    if (skip || !key) return;
    void api<Suggestion>(`/api/games/suggest?key=${encodeURIComponent(key)}`).then((s) => {
      if (s.launchDir) apply(s);
    });
  }, [key, skip]);
}

function AddGame({ onDone }: { onDone: () => void }) {
  const { games } = useHub();
  const known = useApi<string[]>("/api/games/known", 0);
  const [key, setKey] = useState("");
  const keyTyped = useRef(false);
  // Suggest the first game in games/ that isn't connected yet, unless you've typed a key already.
  useEffect(() => {
    if (!known.data || keyTyped.current) return;
    setKey(known.data.find((k) => !games.some((g) => g.key === k)) ?? "");
  }, [known.data]);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:3000");
  const [launch, setLaunch] = useState<Launch>({ launchDir: "", launchCmd: "", autostart: true, publicAccess: false, funnelPort: 443 });
  const { busy, run } = useAction();
  // What the last suggestion filled in: those fields follow the key until you edit them.
  const last = useRef<Suggestion>({});

  useSuggestion(key, false, (s) => {
    const prev = last.current;
    const follow = <T,>(current: T, before: T | undefined, next: T | undefined) => (next !== undefined && (!current || current === before) ? next : current);
    setName((n) => follow(n, prev.name, s.name));
    setBaseUrl((u) => follow(u, prev.baseUrl ?? "http://127.0.0.1:3000", s.baseUrl));
    setLaunch((l) => ({
      ...l,
      launchDir: follow(l.launchDir, prev.launchDir, s.launchDir),
      launchCmd: follow(l.launchCmd, prev.launchCmd, s.launchCmd),
      publicAccess: s.publicAccess ?? l.publicAccess,
      funnelPort: follow(l.funnelPort, prev.funnelPort ?? 443, s.funnelPort),
    }));
    last.current = s;
  });

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
          <input
            value={key}
            onChange={(e) => {
              keyTyped.current = true;
              setKey(e.target.value.toLowerCase());
            }}
          />
        </label>
        <label className="wide">
          <span>Address LucidHub uses to reach the game (on this PC: http://127.0.0.1:port)</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
      </div>
      <LaunchFields value={launch} onChange={setLaunch} />
      <div className="row end">
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy} onClick={() => run(async () => { await api<GameRow>("/api/games", { body: { key, name, baseUrl, ...launch } }); onDone(); }, "Game connected")}>
          Connect
        </button>
      </div>
    </section>
  );
}

function LaunchFields({ value: v, onChange }: { value: Launch; onChange: (l: Launch) => void }) {
  const set = (patch: Partial<Launch>) => onChange({ ...v, ...patch });
  return (
    <div className="launch">
      <h4>Run its server from LucidHub</h4>
      <div className="form-grid">
        <label className="wide">
          <span>Server folder (full path)</span>
          <input className="mono" value={v.launchDir} onChange={(e) => set({ launchDir: e.target.value })} placeholder="C:\…\event-hub\games\poker-tournament" />
        </label>
        <label className="wide">
          <span>Start command, run in that folder</span>
          <input className="mono" value={v.launchCmd} onChange={(e) => set({ launchCmd: e.target.value })} placeholder="npm start" />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={v.autostart} onChange={(e) => set({ autostart: e.target.checked })} disabled={!v.launchDir} />
        Start it whenever LucidHub starts, and restart it if it crashes
      </label>
      <label className="check">
        <input type="checkbox" checked={v.publicAccess} onChange={(e) => set({ publicAccess: e.target.checked })} disabled={!v.launchDir} />
        Open it to players on the internet (Tailscale Funnel)
        {v.publicAccess && (
          <select className="inline-select" value={v.funnelPort} onChange={(e) => set({ funnelPort: Number(e.target.value) })}>
            <option value={443}>on the main address</option>
            <option value={8443}>on port 8443</option>
            <option value={10000}>on port 10000</option>
          </select>
        )}
      </label>
    </div>
  );
}

function LaunchEditor({ game, onDone }: { game: GameRow; onDone: () => void }) {
  const [launch, setLaunch] = useState<Launch>({
    launchDir: game.launchDir ?? "",
    launchCmd: game.launchCmd ?? "",
    autostart: game.launchDir ? game.autostart : true,
    publicAccess: game.publicAccess,
    funnelPort: game.funnelPort,
  });
  const { busy, run } = useAction();

  useSuggestion(game.key, Boolean(game.launchDir), (s) =>
    setLaunch((l) => ({ ...l, launchDir: l.launchDir || s.launchDir!, launchCmd: l.launchCmd || s.launchCmd!, publicAccess: s.publicAccess ?? l.publicAccess })),
  );

  return (
    <div className="setup-box">
      <LaunchFields value={launch} onChange={setLaunch} />
      <p className="muted small">Changes apply the next time the server starts — press Restart after saving.</p>
      <div className="row end">
        {game.launchDir && (
          <button
            className="link danger"
            onClick={() =>
              run(async () => {
                await api(`/api/games/${game.id}`, { method: "PATCH", body: { launchDir: null, launchCmd: null, autostart: false, publicAccess: false } });
                onDone();
              }, "LucidHub won't run this server any more")
            }
          >
            Stop running it from LucidHub
          </button>
        )}
        <button className="btn primary small-btn" disabled={busy} onClick={() => run(async () => { await api(`/api/games/${game.id}`, { method: "PATCH", body: launch }); onDone(); }, "Saved")}>
          Save
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one game

const STATE_LABEL: Record<ServerState, string> = {
  stopped: "Stopped",
  starting: "Starting…",
  running: "Running",
  stopping: "Stopping…",
  crashed: "Crashed",
};

function GameCard({ game, server, onServerChange }: { game: GameRow; server: ServerStatus | null; onServerChange: () => void }) {
  const { reload } = useHub();
  const [info, setInfo] = useState<GameInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const { busy, run } = useAction();
  const online = !game.lastError && game.lastOkAt;
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
          <button className="link" onClick={() => run(async () => { await api(`/api/games/${game.id}`, { method: "PATCH", body: { enabled: !game.enabled } }); await reload(); })}>
            {game.enabled ? "Disable" : "Enable"}
          </button>
        </div>
      </div>
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
                {game.publicAccess && <span className="muted small">· open to players</span>}
              </>
            ) : (
              <span className="muted small">Not run by LucidHub yet — click Set up.</span>
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
        {server?.approveUrl && (
          <p className="notice waiting_stock small">
            Tailscale needs a one-time OK before players can reach {game.name}.{" "}
            <a href={server.approveUrl} target="_blank" rel="noreferrer">
              Approve it here ↗
            </a>
            , then press Restart.
          </p>
        )}
        {live && server?.publicUrl && <PublicAddress name={game.name} url={server.publicUrl} isPublic={game.publicAccess} />}
        {!managed && !editing && <ExternalSetup game={game} />}
        {editing && <LaunchEditor game={game} onDone={() => { setEditing(false); void reload(); }} />}
        {showLog && managed && <ServerLog gameId={game.id} />}
      </div>
    </section>
  );
}

/** For a game running somewhere LucidHub doesn't start it: the two settings it needs. */
function ExternalSetup({ game }: { game: GameRow }) {
  const { toast } = useHub();
  const [secret, setSecret] = useState<string | null>(null);
  const { run } = useAction();
  if (!secret)
    return (
      <p className="muted small">
        Running it somewhere else?{" "}
        <button className="link" onClick={() => run(async () => setSecret((await api<{ secret: string }>(`/api/games/${game.id}/secret`)).secret))}>
          Show the settings it needs
        </button>
      </p>
    );
  const lines = `HUB_URL=${new URL(game.webhookUrl).origin}\nHUB_SECRET=${secret}`;
  return (
    <div className="setup-box">
      <p className="small">Give the game these settings, then restart it. Keep the secret private.</p>
      <pre className="mono">{lines}</pre>
      <button className="btn ghost small-btn" onClick={() => void navigator.clipboard.writeText(lines).then(() => toast("Copied"))}>
        Copy
      </button>
    </div>
  );
}

/** Where players go, and the Discord redirect that address needs for "Sign in with Discord". */
function PublicAddress({ name, url, isPublic }: { name: string; url: string; isPublic: boolean }) {
  const { toast } = useHub();
  const redirect = `${url}/auth/discord/callback`;
  return (
    <div className="setup-box small">
      <div className="row between">
        <span>
          {isPublic ? "Players" : "This PC only"}:{" "}
          <a href={url} target="_blank" rel="noreferrer" className="mono">
            {url}
          </a>
        </span>
      </div>
      <p className="muted" style={{ margin: "8px 0 4px" }}>
        For {name}'s “Sign in with Discord”, this redirect must be in your Discord application (Developer Portal → OAuth2 → Redirects):
      </p>
      <div className="row">
        <code className="mono">{redirect}</code>
        <button className="btn ghost small-btn" onClick={() => void navigator.clipboard.writeText(redirect).then(() => toast("Copied"))}>
          Copy
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
