import { useState } from "react";
import type { TournamentSummary } from "../shared/protocol.ts";
import { formatClock, ordinal, useGame, useServerNow } from "./game.tsx";
import { navigate } from "./router.ts";

export function Lobby() {
  const { tournaments, user } = useGame();
  const active = tournaments.filter((t) => t.status === "registering" || t.status === "running");
  const ended = tournaments.filter((t) => t.status === "finished" || t.status === "cancelled");

  return (
    <main className="page">
      <div className="page-head">
        <h2>Tournaments</h2>
      </div>
      {user.isAdmin && <CreateTournament />}
      {active.length === 0 && (
        <div className="card empty">
          <p>No tournaments scheduled yet.</p>
          <p className="muted">{user.isAdmin ? "Create one above." : "Check back soon."}</p>
        </div>
      )}
      <div className="tlist">
        {active.map((t) => (
          <TournamentCard key={t.id} t={t} />
        ))}
      </div>
      {ended.length > 0 && (
        <>
          <h3 className="section">Recently finished</h3>
          <div className="tlist">
            {ended.map((t) => (
              <TournamentCard key={t.id} t={t} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}

export function statusText(t: TournamentSummary, now: number) {
  if (t.status === "registering") {
    const until = t.startTime - now;
    return until > 0 ? `Starts in ${formatClock(until)}` : t.entrants < 2 ? "Waiting for players" : "Starting…";
  }
  if (t.status === "running") return t.paused ? "Paused" : `Round ${t.round} of ${t.totalRounds}`;
  return t.status === "finished" ? "Finished" : "Cancelled";
}

function TournamentCard({ t }: { t: TournamentSummary }) {
  const { send } = useGame();
  const now = useServerNow(1000);
  const me = t.me;
  const open = () => navigate(`/t/${t.id}`);

  return (
    <div className="card tcard">
      <div className="tcard-main" onClick={open} role="link">
        <div className="tcard-title">
          <strong>{t.name}</strong>
          <span className={`pill ${t.status} ${t.paused ? "paused" : ""}`}>{statusText(t, now)}</span>
        </div>
        <div className="muted small">
          {new Date(t.startTime).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} · {formatRules(t)}
        </div>
        <div className="tcard-stats">
          <span>
            <b>{t.entrants}</b>/{t.maxPlayers} players
          </span>
          {t.status === "running" && (
            <span>
              <b>{t.remaining}</b> left
            </span>
          )}
          {t.status === "running" && (
            <span>
              <b>{t.activeTables}</b> tables
            </span>
          )}
        </div>
      </div>
      <div className="tcard-actions">
        {me?.place != null ? (
          <span className="muted">
            You finished {ordinal(me.place)}
          </span>
        ) : me?.waiting ? (
          <span className="ok">
            ✓ Through to round {me.waiting.round} · waiting for {me.waiting.groupSize - me.waiting.groupDone} more table
            {me.waiting.groupSize - me.waiting.groupDone === 1 ? "" : "s"}
          </span>
        ) : me?.tableId != null ? (
          <button className="btn primary" onClick={() => navigate(`/t/${t.id}/table/${me.tableId}`)}>
            Go to my table
          </button>
        ) : me?.registered ? (
          <>
            <span className="ok">✓ Registered</span>
            {t.status === "registering" && (
              <button className="btn ghost" onClick={() => send({ type: "unregister", tournamentId: t.id })}>
                Unregister
              </button>
            )}
          </>
        ) : me?.removed ? (
          <span className="muted">An admin removed you from this tournament</span>
        ) : me?.pending ? (
          <>
            <span className="muted">⏳ Asked to join · waiting for an admin to let you in</span>
            <button className="btn ghost" onClick={() => send({ type: "unregister", tournamentId: t.id })}>
              Cancel request
            </button>
          </>
        ) : t.registrationOpen ? (
          <button className="btn primary" onClick={() => send({ type: "register", tournamentId: t.id })}>
            {t.access === "closed" ? "Ask to join" : "Register"}
          </button>
        ) : null}
        {t.status === "running" ? (
          <button className={`btn ${me?.tableId != null ? "ghost" : "primary"}`} onClick={() => navigate(`/t/${t.id}/watch`)}>
            👁 Watch live
          </button>
        ) : (
          <button className="btn ghost" onClick={open}>
            Details
          </button>
        )}
      </div>
    </div>
  );
}

/** "4 per table · first to 2 hands · stacking". */
export function formatRules(t: Pick<TournamentSummary, "tableSize" | "winsToAdvance" | "stacking">) {
  const wins = t.winsToAdvance === 1 ? "1 hand wins a table" : `first to ${t.winsToAdvance} hands`;
  return `${t.tableSize} per table · ${wins}${t.stacking ? " · stacking +2/+4" : ""}`;
}

function toLocalInput(ms: number) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function CreateTournament() {
  const { notify } = useGame();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(() => ({
    name: "Uno Night",
    start: toLocalInput(Date.now() + 30 * 60_000),
    maxPlayers: 100,
    tableSize: 4,
    winsToAdvance: 2,
    stacking: "off",
    decisionSeconds: 20,
    timeBankSeconds: 60,
  }));
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: typeof f[k] === "number" ? Number(e.target.value) : e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { start, ...rest } = form;
    const res = await fetch("/api/admin/tournaments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...rest, startTime: new Date(start).getTime() }),
    });
    setBusy(false);
    if (res.ok) {
      notify(`Created "${form.name}"`, "success");
      setOpen(false);
    } else notify((await res.json()).error ?? "Could not create the tournament", "error");
  };

  if (!open)
    return (
      <button className="btn primary create-btn" onClick={() => setOpen(true)}>
        + New tournament
      </button>
    );

  const num = (k: keyof typeof form, label: string, min: number, max: number) => (
    <label>
      {label}
      <input type="number" min={min} max={max} value={form[k] as number} onChange={set(k)} required />
    </label>
  );

  return (
    <form className="card create" onSubmit={submit}>
      <h3>New tournament</h3>
      <p className="muted small">
        Players are drawn to tables. The first to win the set number of hands at a table goes through; the winners meet at new tables
        until one final table is left. Registration closes when it starts.
      </p>
      <div className="grid">
        <label className="wide">
          Name
          <input value={form.name} onChange={set("name")} maxLength={60} required />
        </label>
        <label className="wide">
          Start time
          <input type="datetime-local" value={form.start} onChange={set("start")} required />
        </label>
        {num("maxPlayers", "Max players", 2, 1000)}
        <label>
          Players per table
          <select value={form.tableSize} onChange={set("tableSize")}>
            {[3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Hands to win a table
          <select value={form.winsToAdvance} onChange={set("winsToAdvance")}>
            <option value={1}>1 (fast)</option>
            <option value={2}>First to 2</option>
            <option value={3}>First to 3</option>
          </select>
        </label>
        <label>
          Stacking +2 / +4
          <select value={form.stacking} onChange={set("stacking")}>
            <option value="off">Off — official rules</option>
            <option value="on">On — pass draw penalties on</option>
          </select>
        </label>
        {num("decisionSeconds", "Seconds per turn", 5, 60)}
        {num("timeBankSeconds", "Time bank (seconds)", 0, 300)}
      </div>
      <div className="row">
        <button className="btn primary" disabled={busy}>
          Create
        </button>
        <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
