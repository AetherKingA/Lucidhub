import { useState } from "react";
import type { TournamentSummary } from "../shared/protocol.ts";
import { chips, formatClock, ordinal, useGame, useServerNow } from "./game.tsx";
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
  if (t.status === "running") {
    if (t.paused) return "Paused";
    return t.phase === "break" ? "On break" : `Level ${t.level + 1}`;
  }
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
          {new Date(t.startTime).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} · NLHE freezeout ·{" "}
          {chips(t.startingStack)} chips
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
              Blinds <b>{chips(t.levelInfo.smallBlind)}/{chips(t.levelInfo.bigBlind)}</b>
            </span>
          )}
        </div>
      </div>
      <div className="tcard-actions">
        {me?.place != null ? (
          <span className="muted">
            You finished {ordinal(me.place)}
            {me.points ? ` · +${me.points} pts` : ""}
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
        ) : t.lateRegOpen && t.entrants < t.maxPlayers ? (
          <button className="btn primary" onClick={() => send({ type: "register", tournamentId: t.id })}>
            {t.status === "running" ? "Late register" : "Register"}
          </button>
        ) : null}
        <button className="btn ghost" onClick={open}>
          {t.status === "running" ? "Watch" : "Details"}
        </button>
      </div>
    </div>
  );
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
    name: "Friday Night Poker",
    start: toLocalInput(Date.now() + 30 * 60_000),
    startingStack: 10000,
    levelMinutes: 10,
    lateRegLevels: 6,
    maxPlayers: 1000,
    breakEveryLevels: 6,
    breakMinutes: 5,
    decisionSeconds: 20,
    payoutPercent: 15,
  }));
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "number" ? Number(e.target.value) : e.target.value }));

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
      <div className="grid">
        <label className="wide">
          Name
          <input value={form.name} onChange={set("name")} maxLength={60} required />
        </label>
        <label className="wide">
          Start time
          <input type="datetime-local" value={form.start} onChange={set("start")} required />
        </label>
        {num("startingStack", "Starting chips", 1000, 1_000_000)}
        {num("levelMinutes", "Minutes per level", 1, 60)}
        {num("lateRegLevels", "Late registration (levels)", 0, 30)}
        {num("maxPlayers", "Max players", 2, 1000)}
        {num("breakEveryLevels", "Break every N levels (0 = none)", 0, 30)}
        {num("breakMinutes", "Break length (min)", 0, 60)}
        {num("decisionSeconds", "Seconds per decision", 5, 120)}
        {num("payoutPercent", "% of field paid", 1, 50)}
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
