import { useState } from "react";
import type { GameInfo, GameRow } from "../shared/protocol.ts";
import { api, fmtAgo } from "./api.ts";
import { Empty, PageHeader, useAction, useHub } from "./ui.tsx";

export function GamesPage() {
  const { games, reload } = useHub();
  const [adding, setAdding] = useState(games.length === 0);

  return (
    <>
      <PageHeader title="Games" sub="Each game site plugs into the hub with a shared secret. Add chess (or anything else) the same way once it speaks the hub's API.">
        {!adding && (
          <button className="btn primary" onClick={() => setAdding(true)}>
            + Connect a game
          </button>
        )}
      </PageHeader>
      {adding && <AddGame onDone={() => { setAdding(false); void reload(); }} />}
      {games.length === 0 && !adding ? (
        <Empty>No games connected.</Empty>
      ) : (
        games.map((g) => <GameCard key={g.id} game={g} />)
      )}
    </>
  );
}

function AddGame({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState("poker");
  const [name, setName] = useState("Poker Night");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:3000");
  const { busy, run } = useAction();
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
          <span>Address the hub uses to reach the game (on this PC: http://127.0.0.1:port)</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
      </div>
      <p className="muted small">After connecting, copy the two lines shown into that game's .env and restart it.</p>
      <div className="row end">
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy} onClick={() => run(async () => { await api("/api/games", { body: { key, name, baseUrl } }); onDone(); }, "Game connected")}>
          Connect
        </button>
      </div>
    </section>
  );
}

function GameCard({ game }: { game: GameRow }) {
  const { reload, toast } = useHub();
  const [secret, setSecret] = useState<string | null>(null);
  const [info, setInfo] = useState<GameInfo | null>(null);
  const { busy, run } = useAction();
  const online = !game.lastError && game.lastOkAt;
  const hubUrl = game.webhookUrl.replace(/\/api\/games\/.*$/, "");

  const envLines = secret ? `HUB_URL=${hubUrl}\nHUB_SECRET=${secret}` : null;

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
          <p className="small">Add these to the game's <code>.env</code>, then restart it. Keep the secret private.</p>
          <pre className="mono">{envLines}</pre>
          <button className="btn ghost small-btn" onClick={() => void navigator.clipboard.writeText(envLines).then(() => toast("Copied"))}>
            Copy
          </button>
        </div>
      )}
      {info && <p className="muted small">Game reports: {info.name}, {info.fields.length} event options.</p>}
    </section>
  );
}
