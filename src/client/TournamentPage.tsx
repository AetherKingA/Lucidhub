import { useCallback, useEffect, useState } from "react";
import type { TournamentDetail, TournamentSummary } from "../shared/protocol.ts";
import { chips, formatClock, ordinal, useGame, useServerNow } from "./game.tsx";
import { statusText } from "./Lobby.tsx";
import { navigate } from "./router.ts";

type Tab = "tables" | "standings" | "structure" | "payouts" | "admin";

export function TournamentPage({ id }: { id: number }) {
  const { tournaments, user, send } = useGame();
  const live = tournaments.find((t) => t.id === id);
  const [detail, setDetail] = useState<TournamentDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState<Tab>("tables");
  const now = useServerNow(1000);

  const load = useCallback(async () => {
    const res = await fetch(`/api/tournaments/${id}`);
    if (res.status === 404) return setMissing(true);
    if (res.ok) setDetail(await res.json());
  }, [id]);

  // Standings and tables change constantly while running; refresh every few seconds.
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  if (missing) return <main className="page"><p className="muted">That tournament doesn't exist (any more).</p><a href="#/">Back to the lobby</a></main>;
  const t = live ?? detail?.summary;
  if (!t) return <div className="center muted">Loading…</div>;
  const me = t.me;

  return (
    <main className="page">
      <a className="back" href="#/">
        ← Lobby
      </a>
      <div className="page-head">
        <h2>{t.name}</h2>
        <span className={`pill ${t.status} ${t.paused ? "paused" : ""}`}>{statusText(t, now)}</span>
      </div>

      {t.paused && t.pauseReason && <p className="banner">⏸ {t.pauseReason}</p>}

      <ClockPanel t={t} averageStack={detail?.averageStack ?? 0} />

      <div className="row my-status">
        {me?.place != null ? (
          <span>
            You finished <b>{ordinal(me.place)}</b>
            {me.points ? ` and won ${me.points} points` : ""}.
          </span>
        ) : me?.tableId != null ? (
          <button className="btn primary" onClick={() => navigate(`/t/${t.id}/table/${me.tableId}`)}>
            Go to my table (table {me.tableId})
          </button>
        ) : me?.registered ? (
          <>
            <span className="ok">✓ You're registered. You'll be taken to your table when it starts.</span>
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
      </div>

      <nav className="tabs">
        {(["tables", "standings", "structure", "payouts", ...(user.isAdmin ? ["admin" as const] : [])] as Tab[]).map((k) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
            {k[0]!.toUpperCase() + k.slice(1)}
          </button>
        ))}
      </nav>

      {detail && tab === "tables" && <TablesTab t={t} detail={detail} />}
      {detail && tab === "standings" && <StandingsTab detail={detail} />}
      {detail && tab === "structure" && <StructureTab t={t} detail={detail} />}
      {detail && tab === "payouts" && <PayoutsTab detail={detail} />}
      {tab === "admin" && user.isAdmin && <AdminTab t={t} onChange={load} />}
    </main>
  );
}

function ClockPanel({ t, averageStack }: { t: TournamentSummary; averageStack: number }) {
  const now = useServerNow(500);
  const left = t.phaseEndsAt !== null ? t.phaseEndsAt - now : t.phaseRemainingMs;
  const lvl = t.levelInfo;
  return (
    <div className="clock card">
      <div>
        <div className="label">{t.status === "registering" ? "Starts in" : t.phase === "break" ? "Break ends in" : `Level ${t.level + 1} ends in`}</div>
        <div className="big">
          {t.status === "registering" ? formatClock(t.startTime - now) : t.status === "running" && left !== null ? formatClock(left) : "—"}
        </div>
      </div>
      <div>
        <div className="label">Blinds</div>
        <div className="big">
          {chips(lvl.smallBlind)}/{chips(lvl.bigBlind)}
          {lvl.ante > 0 && <small> ante {chips(lvl.ante)}</small>}
        </div>
        {t.nextLevelInfo && (
          <div className="muted small">
            Next: {chips(t.nextLevelInfo.smallBlind)}/{chips(t.nextLevelInfo.bigBlind)}
            {t.nextLevelInfo.ante > 0 && ` ante ${chips(t.nextLevelInfo.ante)}`}
          </div>
        )}
      </div>
      <div>
        <div className="label">Players</div>
        <div className="big">
          {t.status === "running" ? `${t.remaining} / ${t.entrants}` : t.entrants}
        </div>
        <div className="muted small">{t.lateRegOpen ? "Registration open" : "Registration closed"}</div>
      </div>
      {t.status === "running" && (
        <div>
          <div className="label">Average stack</div>
          <div className="big">{chips(averageStack)}</div>
        </div>
      )}
    </div>
  );
}

function TablesTab({ t, detail }: { t: TournamentSummary; detail: TournamentDetail }) {
  if (!detail.tables.length) return <p className="muted">{t.status === "registering" ? "Tables are drawn when the tournament starts." : "No tables in play."}</p>;
  return (
    <div className="table-grid">
      {detail.tables.map((tb) => (
        <a key={tb.id} className={`card table-tile ${t.me?.tableId === tb.id ? "mine" : ""}`} href={`#/t/${t.id}/table/${tb.id}`}>
          <b>Table {tb.id}</b>
          <span className="muted small">
            {tb.players} players · hand #{tb.handNo}
          </span>
        </a>
      ))}
    </div>
  );
}

function StandingsTab({ detail }: { detail: TournamentDetail }) {
  return (
    <table className="data">
      <thead>
        <tr>
          <th>#</th>
          <th>Player</th>
          <th className="num">Chips</th>
          <th className="num">Points</th>
        </tr>
      </thead>
      <tbody>
        {detail.standings.map((s, i) => (
          <tr key={s.userId} className={s.place !== null ? "out" : ""}>
            <td>{s.place ?? i + 1}</td>
            <td>{s.username}</td>
            <td className="num">{s.place === null ? chips(s.chips) : "—"}</td>
            <td className="num">{s.points || ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StructureTab({ t, detail }: { t: TournamentSummary; detail: TournamentDetail }) {
  return (
    <>
      <p className="muted small">
        {detail.levels[0]!.minutes}-minute levels · late registration for {detail.lateRegLevels} levels
        {detail.breakEveryLevels > 0 && detail.breakMinutes > 0 && ` · ${detail.breakMinutes}-minute break every ${detail.breakEveryLevels} levels`}
      </p>
      <table className="data">
        <thead>
          <tr>
            <th>Level</th>
            <th className="num">Small blind</th>
            <th className="num">Big blind</th>
            <th className="num">Ante</th>
          </tr>
        </thead>
        <tbody>
          {detail.levels.map((l, i) => (
            <tr key={i} className={t.status === "running" && i === t.level ? "current" : ""}>
              <td>{i + 1}</td>
              <td className="num">{chips(l.smallBlind)}</td>
              <td className="num">{chips(l.bigBlind)}</td>
              <td className="num">{l.ante ? chips(l.ante) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function PayoutsTab({ detail }: { detail: TournamentDetail }) {
  return (
    <>
      <p className="muted small">Play money: the prize pool is 100 leaderboard points per entrant. Updates as players register.</p>
      <table className="data">
        <thead>
          <tr>
            <th>Place</th>
            <th className="num">Share</th>
            <th className="num">Points</th>
          </tr>
        </thead>
        <tbody>
          {detail.payouts.map((p) => (
            <tr key={p.place}>
              <td>{ordinal(p.place)}</td>
              <td className="num">{p.percent.toFixed(2)}%</td>
              <td className="num">{p.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function AdminTab({ t, onChange }: { t: TournamentSummary; onChange: () => void }) {
  const { notify } = useGame();
  const [flags, setFlags] = useState<{ tableId: number; players: { userId: number; username: string }[] }[] | null>(null);

  const op = async (name: string, body?: object, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    const res = await fetch(`/api/admin/tournaments/${t.id}/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) notify((await res.json()).error ?? "Failed", "error");
    onChange();
    if (name === "kick") loadFlags();
  };

  const loadFlags = async () => {
    const res = await fetch(`/api/admin/tournaments/${t.id}/flags`);
    if (res.ok) setFlags(await res.json());
  };

  useEffect(() => {
    if (t.status === "running") loadFlags();
  }, [t.status]);

  const over = t.status === "finished" || t.status === "cancelled";
  return (
    <div className="admin">
      <div className="row">
        {t.status === "registering" && (
          <button className="btn primary" onClick={() => op("start", undefined, `Start now with ${t.entrants} players?`)}>
            Start now
          </button>
        )}
        {t.status === "running" && !t.paused && (
          <button className="btn" onClick={() => op("pause")}>
            Pause
          </button>
        )}
        {t.status === "running" && t.paused && (
          <button className="btn primary" onClick={() => op("resume")}>
            Resume
          </button>
        )}
        {!over && (
          <button className="btn danger" onClick={() => op("cancel", undefined, "Cancel this tournament for everyone? This can't be undone.")}>
            Cancel tournament
          </button>
        )}
      </div>

      {t.status === "running" && (
        <>
          <h3 className="section">
            Shared-IP flags <button className="link" onClick={loadFlags}>refresh</button>
          </h3>
          <p className="muted small">
            Players at the same table who have signed in from the same IP address. Could be housemates — or one person on two accounts.
          </p>
          {flags?.length === 0 && <p className="muted">No flags right now.</p>}
          {flags?.map((f, i) => (
            <div key={i} className="card flag">
              <span>Table {f.tableId}:</span>
              {f.players.map((p) => (
                <span key={p.userId} className="flag-player">
                  {p.username}
                  <button className="link danger" onClick={() => op("kick", { userId: p.userId }, `Remove ${p.username} from the tournament?`)}>
                    remove
                  </button>
                </span>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
