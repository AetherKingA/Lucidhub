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
          {new Date(t.startTime).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} · 6-max shootout ·{" "}
          {t.chipMode === "bully" ? (
            <>
              {chips(t.startingStack)} chips · <b className="mode-bully">Full-on Bullying</b>
            </>
          ) : (
            <>
              {chips(t.startingStack)} chips every round · <b className="mode-fair">Fair Play</b>
            </>
          )}
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
            {me.points ? ` · +${me.points} pts` : ""}
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
    chipMode: "fair",
    levelMinutes: 10,
    maxPlayers: 1296,
    breakEveryLevels: 6,
    breakMinutes: 5,
    decisionSeconds: 20,
    payoutPercent: 15,
    rabbitHunt: "on",
  }));
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "number" || k === "maxPlayers" ? Number(e.target.value) : e.target.value }));

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
        6-max shootout: each table plays until one player has every chip, and the winners of six tables meet at a new table with
        the blinds back at level 1. Registration closes when it starts.
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
        {num("startingStack", "Starting chips", 1000, 1_000_000)}
        <label>
          Chips between rounds
          <select value={form.chipMode} onChange={set("chipMode")}>
            <option value="fair">Fair Play — everyone starts each table equal</option>
            <option value="bully">Full-on Bullying — winners keep all their chips</option>
          </select>
        </label>
        {num("levelMinutes", "Minutes per level", 1, 60)}
        <label>
          Max players
          <select value={form.maxPlayers} onChange={set("maxPlayers")}>
            {[6, 36, 216, 1296].map((n, i) => (
              <option key={n} value={n}>
                {n.toLocaleString()} ({i + 1} round{i ? "s" : ""})
              </option>
            ))}
          </select>
        </label>
        {num("breakEveryLevels", "Break every N levels (0 = none)", 0, 30)}
        {num("breakMinutes", "Break length (min)", 0, 60)}
        {num("decisionSeconds", "Seconds per decision", 5, 120)}
        {num("payoutPercent", "% of field paid", 1, 50)}
        <label>
          Rabbit Hunt
          <select value={form.rabbitHunt} onChange={set("rabbitHunt")}>
            <option value="on">On — show the cards that would have come</option>
            <option value="off">Off</option>
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
