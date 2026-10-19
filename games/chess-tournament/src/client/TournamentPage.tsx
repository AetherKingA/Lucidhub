import { useCallback, useEffect, useState } from "react";
import type { TournamentDetail, TournamentSummary } from "../shared/protocol.ts";
import { formatClock, ordinal, useGame, useServerNow } from "./game.tsx";
import { formatRules, statusText } from "./Lobby.tsx";
import { navigate } from "./router.ts";

type Tab = "tables" | "standings" | "rules" | "admin";

/** The tournament's details (boards, standings…), refreshed every few seconds while `enabled`. */
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

  // Standings and boards change constantly while running; refresh every few seconds.
  useEffect(() => {
    if (!enabled) return;
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load, enabled]);

  // Also refresh straight away when the live summary shows a knockout, a finished match or a new round.
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

  // "Watch live" links land on the boards.
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
            ✓ You're through to round {me.waiting.round}. Your next match starts when the other match in your half of the bracket finishes (
            {me.waiting.groupDone}/{me.waiting.groupSize} done).
          </span>
        ) : me?.tableId != null ? (
          <button className="btn primary" onClick={() => navigate(`/t/${t.id}/table/${me.tableId}`)}>
            Go to my board (board {me.tableId})
          </button>
        ) : me?.registered ? (
          <>
            <span className="ok">✓ You're registered. You'll be taken to your board when it starts.</span>
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
            {TAB_LABEL[k]}
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

const TAB_LABEL: Record<Tab, string> = { tables: "Boards", standings: "Standings", rules: "Rules", admin: "Admin" };

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
          <div className="label">Boards in play</div>
          <div className="big">{t.activeTables}</div>
        </div>
      )}
      <div>
        <div className="label">To win a match</div>
        <div className="big">
          {t.winsToAdvance} <small>game{t.winsToAdvance === 1 ? "" : "s"}</small>
        </div>
        <div className="muted small">Knockout, draws replayed</div>
      </div>
      <div>
        <div className="label">Time control</div>
        <div className="big">
          {t.minutes}+{t.incrementSeconds}
        </div>
        <div className="muted small">
          {t.minutes} min each, +{t.incrementSeconds} s per move
        </div>
      </div>
    </div>
  );
}

function roundName(round: number, total: number) {
  if (round === total) return "Final";
  if (round === total - 1) return "Semi-finals";
  if (round === total - 2) return "Quarter-finals";
  return `Round ${round}`;
}

function TablesTab({ t, detail, watch }: { t: TournamentSummary; detail: TournamentDetail; watch: boolean }) {
  if (t.status === "registering")
    return (
      <p className="muted">
        The bracket is drawn when the tournament starts. Players are paired at random; if the numbers don't work out, some get a bye
        into round 2. With {t.entrants} registered that's {t.totalRounds} round{t.totalRounds === 1 ? "" : "s"}.
      </p>
    );
  return (
    <>
      <div className="rounds">
        {detail.rounds.map((r) => (
          <div key={r.round} className={`card round ${r.done === r.tables ? "done" : ""}`}>
            <b>{roundName(r.round, detail.rounds.length)}</b>
            <span className="muted small">
              {r.done}/{r.tables} match{r.tables === 1 ? "" : "es"} decided
            </span>
          </div>
        ))}
      </div>
      {watch && detail.tables.length > 0 && <h3 className="section">👁 Pick a board to watch</h3>}
      {!detail.tables.length && <p className="muted">No boards in play.</p>}
      <LiveTables t={t} tables={detail.tables} totalRounds={detail.rounds.length} />
    </>
  );
}

/** Tiles linking to every board in play, with how many people are watching each. */
export function LiveTables(p: { t: TournamentSummary; tables: TournamentDetail["tables"]; totalRounds: number; except?: number }) {
  const { t } = p;
  return (
    <div className="table-grid">
      {p.tables
        .filter((tb) => tb.id !== p.except)
        .map((tb) => (
          <a key={tb.id} className={`card table-tile ${t.me?.tableId === tb.id ? "mine" : ""}`} href={`#/t/${t.id}/table/${tb.id}`}>
            <b>
              Board {tb.id} <span className="muted small">· {roundName(tb.round, p.totalRounds)}</span>
            </b>
            <span>{tb.players.join(" vs ")}</span>
            <span className="muted small">
              Game {Math.max(1, tb.gameNo)} · score {tb.score}
              {tb.viewers > 0 && ` · 👁 ${tb.viewers}`}
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
          <th className="num">Round</th>
          <th className="num">Games won</th>
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
          A knockout bracket. Each match is played until someone has won <b>{t.winsToAdvance}</b> game{t.winsToAdvance === 1 ? "" : "s"}.
          The winner goes through to meet the winner of the neighbouring match; the loser is out.
        </li>
        <li>Colors are drawn at random for the first game of a match, then swap every game.</li>
        <li>
          Draws don't count: the match goes on. After two draws in a row the next game is <b>Armageddon</b>: a draw counts as a win for
          Black, so the match always ends.
        </li>
        <li>Odd numbers? Some players get a bye straight into round 2.</li>
        <li>Places: going out in a later round always beats an earlier one.</li>
      </ul>
      <h3>Playing</h3>
      <ul>
        <li>Standard chess rules. Click a piece, then the square to move it to (or drag it). Pawns reaching the last rank let you pick a piece.</li>
        <li>
          <b>Clock:</b> {t.minutes} minutes each per game, plus {t.incrementSeconds} seconds after every move. Run out and you lose the game
          (a draw if your opponent has no way to checkmate).
        </li>
        <li>You have 30 seconds to make your first move of each game, or you lose that game.</li>
        <li>Checkmate, resignation and time end a game; so do stalemate, threefold repetition, the fifty-move rule, insufficient material and agreed draws.</li>
        <li>Offer a draw any time. It stands until your opponent accepts, declines or moves.</li>
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
            Opponents who have signed in from the same IP address. Could be housemates — or one person on two accounts.
          </p>
          {flags?.length === 0 && <p className="muted">No flags right now.</p>}
          {flags?.map((f, i) => (
            <div key={i} className="card flag">
              <span>Board {f.tableId}:</span>
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
