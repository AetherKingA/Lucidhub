import type { Overview } from "../shared/protocol.ts";
import { fmtAgo, fmtTime, ordinal, useApi } from "./api.ts";
import { AwardStatusPill, Empty, EventStatus, PageHeader, useHub } from "./ui.tsx";

export function OverviewPage() {
  const { data } = useApi<Overview>("/api/overview", 4000);
  const { games, bot, prizes } = useHub();
  const needsSetup = games.length === 0 || !bot?.configured || prizes.length === 0;

  return (
    <>
      <PageHeader title="Overview" sub="Everything live across your games. Prizes pay out on their own the second an event ends.">
        <a className="btn primary" href="#/events/new">
          + New event
        </a>
      </PageHeader>

      {needsSetup && (
        <section className="card setup">
          <h3>Finish setting up</h3>
          <ol>
            <li className={bot?.configured ? "done" : ""}>
              Add your bot token to <code>.env</code> and invite the bot to your server — <a href="#/settings">Settings</a>
            </li>
            <li className={games.length ? "done" : ""}>
              Connect your first game —<a href="#/games">Games</a>
            </li>
            <li className={prizes.length ? "done" : ""}>
              Create a prize and paste in its codes — <a href="#/prizes">Prizes</a>
            </li>
          </ol>
        </section>
      )}

      {data?.attention.length ? (
        <section className="attention">
          {data.attention.map((a, i) => (
            <div key={i} className={`notice ${a.kind}`}>
              {a.message}{" "}
              {a.kind === "dm_failed" && <a href="#/awards">Review</a>}
              {(a.kind === "waiting_stock" || a.kind === "low_stock") && <a href="#/prizes">Add codes</a>}
              {a.kind === "bot_offline" && <a href="#/settings">Settings</a>}
              {a.kind === "game_offline" && <a href="#/games">Games</a>}
            </div>
          ))}
        </section>
      ) : data ? (
        <div className="notice ok">All clear. Nothing needs you right now — go touch grass.</div>
      ) : null}

      <div className="grid-2">
        <section className="card">
          <h3>Live now</h3>
          {!data ? (
            <p className="muted">Loading…</p>
          ) : data.live.length === 0 ? (
            <Empty>Nothing running.</Empty>
          ) : (
            <ul className="list">
              {data.live.map((e) => (
                <li key={e.id}>
                  <a href={`#/events/${e.id}`}>{e.name}</a>
                  <span className="muted small">
                    {e.gameName} · {e.entrants} players
                  </span>
                  <EventStatus status={e.status} />
                  {e.status === "running" && e.watchUrl && (
                    <a className="small" href={e.watchUrl} target="_blank" rel="noreferrer">
                      Watch ↗
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <h3>Coming up</h3>
          {!data ? (
            <p className="muted">Loading…</p>
          ) : data.upcoming.length === 0 ? (
            <Empty>
              Nothing scheduled. <a href="#/events/new">Create an event</a>.
            </Empty>
          ) : (
            <ul className="list">
              {data.upcoming.map((e) => (
                <li key={e.id}>
                  <a href={`#/events/${e.id}`}>{e.name}</a>
                  <span className="muted small">
                    {e.gameName} · {fmtTime(e.startTime)} · {e.entrants}/{e.maxPlayers ?? "∞"}
                  </span>
                  {e.rules.length === 0 ? <span className="pill warnpill">No prizes</span> : <span className="pill">{e.rules.length} prize rule{e.rules.length === 1 ? "" : "s"}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card">
        <h3>Latest deliveries</h3>
        {!data ? (
          <p className="muted">Loading…</p>
        ) : data.recentAwards.length === 0 ? (
          <Empty>No prizes handed out yet.</Empty>
        ) : (
          <table className="table">
            <tbody>
              {data.recentAwards.map((a) => (
                <tr key={a.id}>
                  <td>{a.username}</td>
                  <td className="muted">
                    {ordinal(a.place)} in {a.eventName}
                  </td>
                  <td>{a.prizeName}</td>
                  <td>
                    <AwardStatusPill status={a.status} />
                  </td>
                  <td className="muted small">{fmtAgo(a.sentAt ?? a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
