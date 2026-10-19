import { useEffect, useState } from "react";
import type { TournamentView } from "../shared/protocol.ts";
import { serverNow, useGame } from "./App.tsx";
import { Game } from "./Game.tsx";
import { GhostFinale } from "./GhostFinale.tsx";
import { statusText } from "./Lobby.tsx";

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Re-renders every so often, for countdowns. */
function useNow(offset: number, every = 250) {
  const [now, setNow] = useState(() => serverNow(offset));
  useEffect(() => {
    const id = setInterval(() => setNow(serverNow(offset)), every);
    return () => clearInterval(id);
  }, [offset, every]);
  return now;
}

export function TournamentPage({ id, watch }: { id: number; watch: boolean }) {
  const { view, tournaments } = useGame();
  if (!view || view.id !== id) {
    const known = tournaments.some((t) => t.id === id);
    return <main className="page muted">{known ? "Loading…" : "Looking for this tournament…"}</main>;
  }
  return (
    <main className="page">
      <Header view={view} />
      {view.status === "registering" && <Registration view={view} />}
      {view.status === "running" && <Running view={view} watch={watch} />}
      {(view.status === "finale" || view.status === "finished") && <FinaleAndResults view={view} />}
      {view.status === "cancelled" && <p className="card muted">This tournament was cancelled.</p>}
    </main>
  );
}

function Header({ view }: { view: TournamentView }) {
  return (
    <div className="t-header">
      <div>
        <a href="#/" className="muted small">
          ← All tournaments
        </a>
        <h2>{view.name}</h2>
        <span className="muted small">
          {view.durationMinutes}-minute time limit · {view.entrants} players
        </span>
      </div>
      <span className={`pill ${view.status}`}>{statusText(view)}</span>
    </div>
  );
}

function JoinButtons({ view }: { view: TournamentView }) {
  const { send } = useGame();
  const me = view.me;
  if (!me) return null;
  if (me.removed) return <p className="error">An admin removed you from this tournament.</p>;
  if (me.registered)
    return view.status === "registering" ? (
      <button className="btn ghost" onClick={() => send({ type: "unregister", tournamentId: view.id })}>
        Leave
      </button>
    ) : null;
  if (me.pending)
    return (
      <div className="row">
        <span className="muted">You asked to join. An admin will let you in.</span>
        <button className="btn ghost small-btn" onClick={() => send({ type: "unregister", tournamentId: view.id })}>
          Withdraw
        </button>
      </div>
    );
  if (!view.registrationOpen) return <p className="muted">Registration is closed.</p>;
  return (
    <button className="btn primary" onClick={() => send({ type: "register", tournamentId: view.id })}>
      {view.access === "closed" ? "Ask to join" : view.status === "running" ? "Join now (the clock won't wait!)" : "Join"}
    </button>
  );
}

function Registration({ view }: { view: TournamentView }) {
  const { offset } = useGame();
  const now = useNow(offset, 1000);
  return (
    <div className="card stack">
      <p>
        When it starts you get <b>{view.durationMinutes === 1 ? "1 minute" : `${view.durationMinutes} minutes`}</b>. Fly as often as you like and your best run counts. Scores stay
        secret until the end, when everyone's best run races as a ghost and the furthest flight wins.
      </p>
      <p className="muted">{now < view.startTime ? `Starts in ${clock(view.startTime - now)}` : "Starting as soon as two players are in."}</p>
      <JoinButtons view={view} />
      <Players view={view} />
    </div>
  );
}

function Players({ view }: { view: TournamentView }) {
  if (!view.players.length) return null;
  return (
    <div className="players">
      {view.players.map((p) => (
        <span key={p.userId} className="player" title={p.username}>
          <img src={p.avatarUrl} alt="" width={22} height={22} /> {p.username}
        </span>
      ))}
    </div>
  );
}

function Running({ view, watch }: { view: TournamentView; watch: boolean }) {
  const { offset } = useGame();
  const now = useNow(offset);
  const left = view.paused ? (view.remainingMs ?? 0) : (view.endsAt ?? now) - now;
  const timeUp = !view.paused && left <= 0;
  const playing = !watch && view.me?.registered;

  return (
    <div className="running">
      <div className="hud card">
        <div>
          <span className="muted small">Time left</span>
          <b className={`big ${left < 30_000 ? "hurry" : ""}`}>{timeUp ? "Time's up" : clock(left)}</b>
        </div>
        {view.me?.registered && (
          <>
            <div>
              <span className="muted small">Your best</span>
              <b className="big">{view.me.best?.score ?? "–"}</b>
            </div>
            <div>
              <span className="muted small">Attempts</span>
              <b className="big">{view.me.attempts}</b>
            </div>
          </>
        )}
      </div>
      {view.paused && <p className="card notice-inline">⏸ {view.pauseReason ?? "Paused"}. The clock is stopped.</p>}
      {timeUp && <p className="card notice-inline">Time's up! The ghosts are getting ready…</p>}
      {playing ? (
        <Game view={view} />
      ) : (
        <div className="card stack">
          <p>
            {view.entrants} players are flying. Scores are secret until the ghost race at the end. Stay on this page to watch it.
          </p>
          {!watch && <JoinButtons view={view} />}
          <Players view={view} />
        </div>
      )}
    </div>
  );
}

function FinaleAndResults({ view }: { view: TournamentView }) {
  const { user } = useGame();
  const [replayFrom, setReplayFrom] = useState<number | null>(null);
  if (!view.finale || view.seed === null) return <p className="card muted">Getting the ghosts ready…</p>;
  const myPlace = view.results?.find((r) => r.userId === user.id)?.place;
  return (
    <div className="stack">
      <GhostFinale seed={view.seed} finale={view.finale} replayFrom={replayFrom} />
      {view.results && (
        <div className="card">
          <div className="row spread">
            <h3>Results</h3>
            <button className="btn ghost small-btn" onClick={() => setReplayFrom(Date.now() + 1500)}>
              Watch again
            </button>
          </div>
          {myPlace && <p className="ok">You finished #{myPlace}.</p>}
          <table className="results">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Pipes</th>
              </tr>
            </thead>
            <tbody>
              {view.results.map((r) => (
                <tr key={r.userId} className={r.userId === user.id ? "mine" : ""}>
                  <td>{r.place === 1 ? "🏆" : r.place}</td>
                  <td>
                    <img src={r.avatarUrl} alt="" width={20} height={20} /> {r.username}
                  </td>
                  <td>{r.score ?? <span className="muted">no run</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
