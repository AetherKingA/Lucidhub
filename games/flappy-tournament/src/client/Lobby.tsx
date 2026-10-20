import type { TournamentSummary } from "../shared/protocol.ts";
import { useGame } from "./App.tsx";

export function statusText(t: TournamentSummary) {
  if (t.status === "registering") return `Starts ${new Date(t.startTime).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
  if (t.status === "running") return t.paused ? "Paused" : "Flying now";
  if (t.status === "finale") return "Ghost race!";
  if (t.status === "finished") return "Finished";
  return "Cancelled";
}

export function Lobby() {
  const { tournaments } = useGame();
  return (
    <main className="page">
      <h2>Tournaments</h2>
      <p className="muted">Fly as many times as you like before the clock runs out. Only your best run counts, and nobody sees the scores until the ghost race at the end.</p>
      {tournaments.length === 0 && <p className="card muted">No tournaments right now. An admin creates them in LucidHub.</p>}
      <div className="list">
        {tournaments.map((t) => (
          <a key={t.id} className={`card tournament-card ${t.status}`} href={`#/t/${t.id}`}>
            <div>
              <h3>{t.name}</h3>
              <span className="muted small">
                {t.durationMinutes} min · {t.entrants}/{t.maxPlayers} players
                {t.access === "closed" ? " · closed lobby" : ""}
              </span>
            </div>
            <span className={`pill ${t.status}`}>{statusText(t)}</span>
            {t.me?.registered && <span className="badge">You're in</span>}
          </a>
        ))}
      </div>
    </main>
  );
}
