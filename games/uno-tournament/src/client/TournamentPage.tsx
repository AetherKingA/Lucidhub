import { useCallback, useEffect, useState } from "react";
import type { TournamentDetail, TournamentSummary } from "../shared/protocol.ts";
import { formatClock, ordinal, useGame, useServerNow } from "./game.tsx";
import { formatRules, statusText } from "./Lobby.tsx";
import { navigate } from "./router.ts";

type Tab = "tables" | "standings" | "rules" | "admin";

/** The tournament's details (tables, standings…), refreshed every few seconds while `enabled`. */
export function useTournamentDetail(id: number, enabled = true) {
  const { tournaments } = useGame();
  const live = tournaments.find((t) => t.id === id);
  const [detail, setDetail] = useState<TournamentDetail | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/tournaments/${id}`);
    if (res.status === 404) return setMissing(true);
    if (res.ok) setDetail(await res.json());
  }, [id]);

  // Standings and tables change constantly while running; refresh every few seconds.
  useEffect(() => {
    if (!enabled) return;
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load, enabled]);

  // Also refresh straight away when the live summary shows a knockout, a finished table or a new round.
  useEffect(() => {
    if (live && enabled) load();
  }, [live?.status, live?.remaining, live?.activeTables, live?.round]);

  return { detail, missing, load };
}

export function TournamentPage({ id, watch = false }: { id: number; watch?: boolean }) {
  const { tournaments, user, send } = useGame();
  const live = tournaments.find((t) => t.id === id);
  const { detail, missing, load } = useTournamentDetail(id);
  const [tab, setTab] = useState<Tab>("tables");
  const now = useServerNow(1000);

  // "Watch live" links land on the tables.
  useEffect(() => {
    if (watch) setTab("tables");
  }, [watch]);

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
          <span>{me.place === 1 ? "🏆 You won the tournament!" : <>You finished <b>{ordinal(me.place)}</b>.</>}</span>
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
      </div>

      <nav className="tabs">
        {(["tables", "standings", "rules", ...(user.isAdmin ? ["admin" as const] : [])] as Tab[]).map((k) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
            {k[0]!.toUpperCase() + k.slice(1)}
          </button>
        ))}
      </nav>

      {detail && tab === "tables" && <TablesTab t={t} detail={detail} watch={watch} />}
      {detail && tab === "standings" && <StandingsTab detail={detail} />}
      {tab === "rules" && <RulesTab t={t} />}
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
        <div className="label">To win a table</div>
        <div className="big">
          {t.winsToAdvance} <small>hand{t.winsToAdvance === 1 ? "" : "s"}</small>
        </div>
        <div className="muted small">{t.tableSize} players per table</div>
      </div>
      <div>
        <div className="label">Stacking</div>
        <div className={`big ${t.stacking ? "mode-on" : ""}`}>{t.stacking ? "On" : "Off"}</div>
        <div className="muted small">{t.stacking ? "Pass +2 and +4 penalties on." : "Official rules."}</div>
      </div>
    </div>
  );
}

function TablesTab({ t, detail, watch }: { t: TournamentSummary; detail: TournamentDetail; watch: boolean }) {
  if (t.status === "registering")
    return (
      <p className="muted">
        Tables are drawn when the tournament starts: {t.tableSize} players per table, and the winners of every {t.tableSize} tables meet at a
        new table in the next round. With {t.entrants} registered that's {t.totalRounds} round{t.totalRounds === 1 ? "" : "s"}.
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
      {watch && detail.tables.length > 0 && <h3 className="section">👁 Pick a table to watch</h3>}
      {!detail.tables.length && <p className="muted">No tables in play.</p>}
      <LiveTables t={t} tables={detail.tables} />
    </>
  );
}

/** Tiles linking to every table in play, with how many people are watching each. */
export function LiveTables({ t, tables, except }: { t: TournamentSummary; tables: TournamentDetail["tables"]; except?: number }) {
  return (
    <div className="table-grid">
      {tables
        .filter((tb) => tb.id !== except)
        .map((tb) => (
          <a key={tb.id} className={`card table-tile ${t.me?.tableId === tb.id ? "mine" : ""}`} href={`#/t/${t.id}/table/${tb.id}`}>
            <b>
              Table {tb.id} <span className="muted small">· R{tb.round}</span>
            </b>
            <span className="muted small">
              {tb.players} players · hand #{tb.handNo}
              {tb.viewers > 0 && ` · 👁 ${tb.viewers}`}
            </span>
            <span className="muted small">{tb.leader ? `${tb.leader} leads ${tb.leaderWins}/${t.winsToAdvance}` : "No hands won yet"}</span>
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
          <th className="num">Round</th>
          <th className="num">Hands won</th>
        </tr>
      </thead>
      <tbody>
        {detail.standings.map((s) => (
          <tr key={s.userId} className={s.place !== null ? "out" : ""}>
            <td>{s.place ?? "—"}</td>
            <td>{s.username}</td>
            <td className="num">{s.round}</td>
            <td className="num">{s.place === null && s.tableId !== null ? s.wins : s.place === null ? "waiting" : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RulesTab({ t }: { t: TournamentSummary }) {
  return (
    <div className="card rules">
      <h3>This tournament</h3>
      <p>{formatRules(t)}.</p>
      <ul>
        <li>
          Each table plays hands until someone has won <b>{t.winsToAdvance}</b>. They win the table and go through; everyone else at the
          table is out. The winners of {t.tableSize} tables meet at a new table, back on zero wins.
        </li>
        <li>
          Knocked out at the same table? More hands won ranks higher, then fewer card points left over from the hands you lost (numbers
          count their value, action cards 20, wilds 50). Going out in a later round always beats an earlier one.
        </li>
      </ul>
      <h3>Playing</h3>
      <ul>
        <li>Seven cards each. Match the top card by color or by number/symbol, or play a Wild and pick the next color.</li>
        <li>Can't play (or don't want to)? Draw one. If it fits you may play it straight away, otherwise your turn ends.</li>
        <li>
          <b>Skip</b> skips the next player, <b>Reverse</b> changes direction (with two players it's a Skip), <b>Draw Two</b> makes the
          next player draw two and miss their turn.
        </li>
        <li>
          <b>Wild Draw Four</b>: the next player draws four and misses their turn. You may only play it when you have no card of the
          current color.
        </li>
        {t.stacking && (
          <li>
            <b>Stacking is on:</b> hit by a Draw Two, you can pass it on with another Draw Two or a Wild Draw Four; hit by a Wild Draw Four,
            only another Wild Draw Four. Whoever finally draws takes the whole total.
          </li>
        )}
        <li>
          <b>UNO!</b> Press UNO when you're about to go down to one card (or right after). If you forget, anyone can press <b>Catch</b> before
          the next player moves, and you draw two.
        </li>
        <li>Run out of time and the game plays for you (a matching card if it has one) until you click "I'm back".</li>
      </ul>
    </div>
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
