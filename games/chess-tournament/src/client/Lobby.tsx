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
              <b>{t.activeTables}</b> boards
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
            ✓ Through to round {me.waiting.round} · waiting for {me.waiting.groupSize - me.waiting.groupDone} more match
            {me.waiting.groupSize - me.waiting.groupDone === 1 ? "" : "es"}
          </span>
        ) : me?.tableId != null ? (
          <button className="btn primary" onClick={() => navigate(`/t/${t.id}/table/${me.tableId}`)}>
            Go to my board
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
        <button className="btn ghost" onClick={open}>
          {t.status === "running" ? "Watch" : "Details"}
        </button>
      </div>
    </div>
  );
}

/** "5+3 · knockout · first to 2 wins". */
export function formatRules(t: Pick<TournamentSummary, "minutes" | "incrementSeconds" | "winsToAdvance">) {
  const wins = t.winsToAdvance === 1 ? "one game per match" : `first to ${t.winsToAdvance} wins`;
  return `${t.minutes}+${t.incrementSeconds} · knockout · ${wins}`;
}

/** Time controls offered in the form; matches TIME_CONTROLS on the server. */
const TIME_CONTROLS = ["1+0", "3+0", "3+2", "5+0", "5+3", "10+0", "10+5", "15+10"];

function toLocalInput(ms: number) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function CreateTournament() {
  const { notify } = useGame();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(() => ({
    name: "Chess Night",
    start: toLocalInput(Date.now() + 30 * 60_000),
    maxPlayers: 64,
    winsToAdvance: 1,
    timeControl: "5+3",
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
        A knockout bracket. Players are paired at random (byes if the numbers are odd); the first to win the set number of games goes
        through to meet the winner of the next board, until the final. Registration closes when it starts.
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
        {num("maxPlayers", "Max players", 2, 1024)}
        <label>
          Games to win a match
          <select value={form.winsToAdvance} onChange={set("winsToAdvance")}>
            <option value={1}>1 (fast)</option>
            <option value={2}>First to 2</option>
            <option value={3}>First to 3</option>
          </select>
        </label>
        <label>
          Time control
          <select value={form.timeControl} onChange={set("timeControl")}>
            {TIME_CONTROLS.map((tc) => (
              <option key={tc} value={tc}>
                {tc.replace("+", " min + ")} s
              </option>
            ))}
          </select>
        </label>
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
