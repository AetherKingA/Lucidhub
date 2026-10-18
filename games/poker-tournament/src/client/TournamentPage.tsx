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

  // Also refresh straight away when the live summary shows a knockout, a finished table or a new round.
  useEffect(() => {
    if (live) load();
  }, [live?.status, live?.remaining, live?.activeTables, live?.round]);

  if (missing)
    return (
      <main className="page">
        <p className="muted">That tournament doesn't exist (any more).</p>
        <a href="#/">Back to the lobby</a>
      </main>
    );
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

      <OverviewPanel t={t} now={now} />

      <div className="row my-status">
        {me?.place != null ? (
          <span>
            {me.place === 1 ? "🏆 You won the tournament" : <>You finished <b>{ordinal(me.place)}</b></>}
            {me.points ? ` and won ${me.points} points` : ""}.
          </span>
        ) : me?.waiting ? (
          <span className="ok">
            ✓ You won your table and you're through to round {me.waiting.round}. Your next table starts when the other{" "}
            {me.waiting.groupSize - me.waiting.groupDone} table{me.waiting.groupSize - me.waiting.groupDone === 1 ? "" : "s"} in your
            group finish{me.waiting.groupSize - me.waiting.groupDone === 1 ? "es" : ""} ({me.waiting.groupDone}/{me.waiting.groupSize}{" "}
            done).
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
        ) : t.registrationOpen ? (
          <button className="btn primary" onClick={() => send({ type: "register", tournamentId: t.id })}>
            Register
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
      {detail && tab === "structure" && <StructureTab detail={detail} />}
      {detail && tab === "payouts" && <PayoutsTab detail={detail} />}
      {tab === "admin" && user.isAdmin && <AdminTab t={t} onChange={load} />}
    </main>
  );
}

function OverviewPanel({ t, now }: { t: TournamentSummary; now: number }) {
  return (
    <div className="clock card">
      {t.status === "registering" ? (
        <div>
          <div className="label">Starts in</div>
          <div className="big">{formatClock(t.startTime - now)}</div>
        </div>
      ) : (
        <div>
          <div className="label">Round</div>
          <div className="big">
            {t.status === "running" ? t.round : t.totalRounds} <small>of {t.totalRounds}</small>
          </div>
        </div>
      )}
      <div>
        <div className="label">Players</div>
        <div className="big">{t.status === "running" ? `${t.remaining} / ${t.entrants}` : t.entrants}</div>
        <div className="muted small">
          {t.status === "registering" ? `Cap ${t.maxPlayers.toLocaleString()} · ${t.registrationOpen ? "registration open" : "full"}` : "Registration closed"}
        </div>
      </div>
      {t.status === "running" && (
        <div>
          <div className="label">Tables in play</div>
          <div className="big">{t.activeTables}</div>
        </div>
      )}
      <div>
        <div className="label">{t.chipMode === "bully" ? "First table starts" : "Every table starts"}</div>
        <div className="big">
          {chips(t.startingStack)} <small>chips</small>
        </div>
        <div className="muted small">
          Blinds {chips(t.firstLevel.smallBlind)}/{chips(t.firstLevel.bigBlind)}, {t.firstLevel.minutes}-min levels
        </div>
      </div>
      <div>
        <div className="label">Between rounds</div>
        <div className={`big mode-${t.chipMode}`}>{t.chipMode === "bully" ? "Full-on Bullying" : "Fair Play"}</div>
        <div className="muted small">
          {t.chipMode === "bully"
            ? "Table winners keep every chip they won and bring it to their next table."
            : "Everyone starts each new table with the same stack."}
        </div>
      </div>
    </div>
  );
}

function TablesTab({ t, detail }: { t: TournamentSummary; detail: TournamentDetail }) {
  if (t.status === "registering")
    return (
      <p className="muted">
        Tables are drawn when the tournament starts: six players per table, and the winners of every six tables meet at a new table in the
        next round. With {t.entrants} registered that's {t.totalRounds} round{t.totalRounds === 1 ? "" : "s"}.
      </p>
    );
  return (
    <>
      <div className="rounds">
        {detail.rounds.map((r) => (
          <div key={r.round} className={`card round ${r.done === r.tables ? "done" : ""}`}>
            <b>{r.round === detail.rounds.length ? "Final table" : `Round ${r.round}`}</b>
            <span className="muted small">
              {r.done}/{r.tables} table{r.tables === 1 ? "" : "s"} finished · {r.players} players
            </span>
          </div>
        ))}
      </div>
      {!detail.tables.length && <p className="muted">No tables in play.</p>}
      <div className="table-grid">
        {detail.tables.map((tb) => (
          <a key={tb.id} className={`card table-tile ${t.me?.tableId === tb.id ? "mine" : ""}`} href={`#/t/${t.id}/table/${tb.id}`}>
            <b>
              Table {tb.id} <span className="muted small">· R{tb.round}</span>
            </b>
            <span className="muted small">
              {tb.players} left · hand #{tb.handNo}
            </span>
          </a>
        ))}
      </div>
    </>
  );
}

function StandingsTab({ detail }: { detail: TournamentDetail }) {
  return (
    <table className="data">
      <thead>
        <tr>
          <th>#</th>
          <th>Player</th>
          <th className="num">Round</th>
          <th className="num">Chips</th>
          <th className="num">Points</th>
        </tr>
      </thead>
      <tbody>
        {detail.standings.map((s) => (
          <tr key={s.userId} className={s.place !== null ? "out" : ""}>
            <td>{s.place ?? "—"}</td>
            <td>{s.username}</td>
            <td className="num">{s.round}</td>
            <td className="num">{s.place === null && s.tableId !== null ? chips(s.chips) : s.place === null ? "waiting" : "—"}</td>
            <td className="num">{s.points || ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StructureTab({ detail }: { detail: TournamentDetail }) {
  return (
    <>
      <p className="muted small">
        Every table, in every round, starts at level 1
        {detail.summary.chipMode === "bully" ? ". Table winners bring all the chips they won (Full-on Bullying)." : " with fresh, equal stacks (Fair Play)."}{" "}
        {detail.levels[0]!.minutes}-minute levels
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
            <tr key={i}>
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
      <p className="muted small">
        Play money: the prize pool is 100 leaderboard points per entrant. Knockouts in a later round always finish ahead of knockouts in an
        earlier round.
      </p>
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
