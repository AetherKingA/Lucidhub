import { useEffect, useState } from "react";
import type { Award, BlindLevel, GameField, GameInfo, GameLobby, GameOp, GamePlayer, HubEvent, IpLocation, LobbyAccess, PlayerAction, PrizeRule } from "../shared/protocol.ts";
import { api, fmtAgo, fmtTime, ordinal, placeLabel, useApi } from "./api.ts";
import { BlindEditor, levelProblems } from "./Blinds.tsx";
import { navigate } from "./router.ts";
import { AwardStatusPill, ChannelPicker, Empty, EventStatus, LadderEditor, PageHeader, useAction, useHub } from "./ui.tsx";

// ---------------------------------------------------------------- list

export function EventsPage() {
  const [status, setStatus] = useState("");
  const { data } = useApi<HubEvent[]>(`/api/events${status ? `?status=${status}` : ""}`, 4000);
  const { games } = useHub();
  const { busy, run } = useAction();

  return (
    <>
      <PageHeader title="Events" sub="Events from every connected game. Ones created on a game's own site show up here too.">
        <button className="btn ghost" disabled={busy} onClick={() => run(() => api("/api/sync", { body: {} }), "Synced with all games")}>
          ↻ Sync now
        </button>
        <a className="btn primary" href="#/events/new">
          + New event
        </a>
      </PageHeader>
      <div className="tabs">
        {[
          ["", "All"],
          ["registering", "Upcoming"],
          ["running", "Live"],
          ["finished", "Finished"],
          ["cancelled", "Cancelled"],
        ].map(([v, label]) => (
          <button key={v} className={status === v ? "active" : ""} onClick={() => setStatus(v!)}>
            {label}
          </button>
        ))}
      </div>
      <section className="card">
        {!data ? (
          <p className="muted">Loading…</p>
        ) : data.length === 0 ? (
          <Empty>{games.length ? <>No events yet. <a href="#/events/new">Create one</a>.</> : <>Connect a game first on the <a href="#/games">Games</a> page.</>}</Empty>
        ) : (
          <table className="table clickable">
            <thead>
              <tr>
                <th>Event</th>
                <th>Game</th>
                <th>Starts</th>
                <th>Players</th>
                <th>Prizes</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id} onClick={() => navigate(`/events/${e.id}`)}>
                  <td>
                    <a href={`#/events/${e.id}`}>{e.name}</a>
                  </td>
                  <td className="muted">{e.gameName}</td>
                  <td className="muted">{fmtTime(e.startTime)}</td>
                  <td>
                    {e.entrants}
                    {e.maxPlayers ? <span className="muted">/{e.maxPlayers}</span> : null}
                    {e.access === "closed" && e.status === "registering" && <span className="muted small"> · closed</span>}
                    {e.pending > 0 && <> <span className="pill warnpill">{e.pending} waiting</span></>}
                  </td>
                  <td>{e.rules.length ? <PrizeSummary e={e} /> : <span className="pill warnpill">None</span>}</td>
                  <td>
                    <EventStatus status={e.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function PrizeSummary({ e }: { e: HubEvent }) {
  const sent = (e.awardCounts.sent ?? 0) + (e.awardCounts.manual ?? 0);
  const total = Object.entries(e.awardCounts).reduce((n, [k, v]) => (k === "cancelled" ? n : n + v), 0);
  if (total) return <span className={sent === total ? "ok" : "warn"}>{sent}/{total} delivered</span>;
  return <span className="muted">{e.rules.length} rule{e.rules.length === 1 ? "" : "s"}</span>;
}

// ---------------------------------------------------------------- create

/** Turns a field's value for display in an <input> (datetime fields are epoch ms on the wire). */
const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

function initialValues(fields: GameField[]) {
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (f.type === "datetime") {
      const start = new Date(Date.now() + 60 * 60_000);
      start.setMinutes(0, 0, 0);
      out[f.name] = toLocalInput(typeof f.default === "number" && f.default > Date.now() ? f.default : start.getTime());
    } else if (f.type === "blinds") continue; // kept as levels, not text
    else out[f.name] = f.default !== undefined ? String(f.default) : "";
  }
  return out;
}

export function NewEventPage() {
  const { loaded, games, bot } = useHub();
  const enabled = games.filter((g) => g.enabled);
  const [gameId, setGameId] = useState<number | null>(null);
  const [info, setInfo] = useState<GameInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [blinds, setBlinds] = useState<Record<string, BlindLevel[]>>({});
  const [rules, setRules] = useState<PrizeRule[]>([]);
  const [channel, setChannel] = useState("");
  const { busy, run } = useAction();

  useEffect(() => {
    if (gameId === null && enabled[0]) setGameId(enabled[0].id);
  }, [enabled, gameId]);

  useEffect(() => {
    if (gameId === null) return;
    setInfo(null);
    setInfoError(null);
    api<GameInfo>(`/api/games/${gameId}/info`)
      .then((i) => {
        setInfo(i);
        setValues(initialValues(i.fields));
        setBlinds(
          Object.fromEntries(i.fields.filter((f) => f.type === "blinds").map((f) => [f.name, Array.isArray(f.default) ? f.default.map((l) => ({ ...l })) : []])),
        );
      })
      .catch((err) => setInfoError((err as Error).message));
  }, [gameId]);

  if (!loaded) return <p className="muted">Loading…</p>;
  if (enabled.length === 0)
    return (
      <>
        <PageHeader title="New event" />
        <Empty>
          Connect a game first on the <a href="#/games">Games</a> page.
        </Empty>
      </>
    );

  const blindFields = info?.fields.filter((f) => f.type === "blinds") ?? [];

  const submit = () =>
    run(async () => {
      if (rules.some((r) => !r.prizeId)) throw new Error("Pick a prize on every row of the prize ladder");
      const options: Record<string, unknown> = {};
      for (const f of info!.fields) {
        if (f.type === "blinds") {
          const levels = blinds[f.name] ?? [];
          const bad = levelProblems(levels).findIndex(Boolean);
          if (bad >= 0) throw new Error(`Blinds, level ${bad + 1}: ${levelProblems(levels)[bad]}`);
          options[f.name] = levels;
          continue;
        }
        const v = values[f.name] ?? "";
        if (v === "") continue;
        options[f.name] = f.type === "datetime" ? new Date(v).getTime() : f.type === "number" || (f.type === "select" && typeof f.options?.[0]?.value === "number") ? Number(v) : v;
      }
      const ev = await api<HubEvent>("/api/events", { body: { gameId, options, rules, announceChannelId: channel || undefined } });
      navigate(`/events/${ev.id}`);
    }, "Event created");

  return (
    <>
      <PageHeader title="New event" sub="Set it up once — the game runs it, and the bot pays out the winners when it ends." />
      <section className="card">
        <h3>1. Game</h3>
        <div className="seg">
          {enabled.map((g) => (
            <button key={g.id} className={g.id === gameId ? "active" : ""} onClick={() => setGameId(g.id)}>
              {g.name}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>2. Event details</h3>
        {infoError ? (
          <p className="error">{infoError}</p>
        ) : !info ? (
          <p className="muted">Asking the game for its options…</p>
        ) : (
          <div className="form-grid">
            {info.fields.filter((f) => f.type !== "blinds").map((f) => (
              <label key={f.name} className={f.type === "text" ? "wide" : ""}>
                <span>{f.label}</span>
                {f.type === "select" ? (
                  <select value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
                    {f.options?.map((o) => (
                      <option key={String(o.value)} value={String(o.value)}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={f.type === "datetime" ? "datetime-local" : f.type}
                    min={f.min}
                    max={f.max}
                    value={values[f.name] ?? ""}
                    onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                  />
                )}
                {f.help && <small className="muted">{f.help}</small>}
              </label>
            ))}
          </div>
        )}
      </section>

      {blindFields.map((f) => (
        <section className="card" key={f.name}>
          <h3>3. {f.label}</h3>
          {f.help && <p className="muted small">{f.help}</p>}
          <BlindEditor
            gameId={gameId!}
            field={f}
            levels={blinds[f.name] ?? []}
            onChange={(levels) => setBlinds((b) => ({ ...b, [f.name]: levels }))}
            values={values}
            onSetValues={(set) => setValues((v) => ({ ...v, ...Object.fromEntries(Object.entries(set).filter(([k]) => k in v).map(([k, n]) => [k, String(n)])) }))}
          />
        </section>
      ))}

      <section className="card">
        <h3>{blindFields.length ? 4 : 3}. Prizes</h3>
        <p className="muted small">Each winner in these places gets a DM with their prize the moment the event ends.</p>
        <LadderEditor rules={rules} onChange={setRules} />
      </section>

      <section className="card">
        <h3>{blindFields.length ? 5 : 4}. Announce winners in</h3>
        <ChannelPicker value={channel} onChange={setChannel} placeholder={bot?.channels.length ? "Default announcement channel (Settings)" : undefined} />
      </section>

      <div className="row end">
        <a className="btn ghost" href="#/events">
          Cancel
        </a>
        <button className="btn primary" disabled={busy || !info} onClick={submit}>
          Create event
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- detail

type EventDetail = HubEvent & { awards: Award[] };

export function EventPage({ id }: { id: number }) {
  const { data, error, reload } = useApi<EventDetail>(`/api/events/${id}`, 4000);
  const [rules, setRules] = useState<PrizeRule[] | null>(null);
  const { busy, run } = useAction();

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const editing = rules !== null;
  const locked = data.awards.length > 0;
  const op = (o: GameOp, label: string) => {
    if (o === "cancel" && !confirm(`Cancel "${data.name}"? Nobody will get prizes from it.`)) return;
    void run(async () => {
      await api(`/api/events/${id}/op/${o}`, { body: {} });
      await reload();
    }, label);
  };

  return (
    <>
      <PageHeader
        title={data.name}
        sub={
          <>
            {data.gameName} · {fmtTime(data.startTime)} · {data.entrants}
            {data.maxPlayers ? `/${data.maxPlayers}` : ""} players {data.url && <> · <a href={data.url} target="_blank" rel="noreferrer">Open in {data.gameName} ↗</a></>}
          </>
        }
      >
        <EventStatus status={data.status} />
        {data.status === "registering" && (
          <button className="btn primary" disabled={busy} onClick={() => op("start", "Started")}>
            Start now
          </button>
        )}
        {data.status === "running" && (
          <>
            <button className="btn ghost" disabled={busy} onClick={() => op("pause", "Paused")}>
              Pause
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => op("resume", "Resumed")}>
              Resume
            </button>
          </>
        )}
        {(data.status === "registering" || data.status === "running") && (
          <button className="btn danger" disabled={busy} onClick={() => op("cancel", "Cancelled")}>
            Cancel event
          </button>
        )}
      </PageHeader>

      {data.access !== null && (data.status === "registering" || data.status === "running") && <LobbyPanel event={data} onChange={reload} />}

      <section className="card">
        <div className="row between">
          <h3>Prize ladder</h3>
          {!locked && !editing && (
            <button className="btn ghost small-btn" onClick={() => setRules(data.rules.map(({ placeFrom, placeTo, prizeId }) => ({ placeFrom, placeTo, prizeId })))}>
              Edit
            </button>
          )}
        </div>
        {editing ? (
          <>
            <LadderEditor rules={rules} onChange={setRules} />
            <div className="row end">
              <button className="btn ghost" onClick={() => setRules(null)}>
                Discard
              </button>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    if (rules.some((r) => !r.prizeId)) throw new Error("Pick a prize on every row");
                    await api(`/api/events/${id}/rules`, { method: "PUT", body: { rules } });
                    setRules(null);
                    await reload();
                  }, data.status === "finished" ? "Saved — sending prizes now" : "Prize ladder saved")
                }
              >
                Save ladder
              </button>
            </div>
          </>
        ) : data.rules.length === 0 ? (
          <Empty>No prizes attached{data.status === "finished" ? " — add some now and they'll be sent to this event's winners." : "."}</Empty>
        ) : (
          <LadderView rules={data.rules} />
        )}
        {locked && <p className="muted small">Locked — prizes for this event have been handed out.</p>}
      </section>

      <section className="card">
        <h3>Announcement channel</h3>
        <div className="row">
          <ChannelPicker
            value={data.announceChannelId ?? ""}
            onChange={(v) => run(async () => { await api(`/api/events/${id}/channel`, { method: "PUT", body: { channelId: v || null } }); await reload(); }, "Saved")}
          />
        </div>
      </section>

      <section className="card">
        <h3>Winners & deliveries</h3>
        {data.awards.length === 0 ? (
          <Empty>{data.status === "finished" || data.status === "cancelled" ? "No prizes were handed out for this event." : "Prizes are sent automatically when the event ends."}</Empty>
        ) : (
          <AwardTable awards={[...data.awards].sort((a, b) => a.place - b.place || a.id - b.id)} onChange={reload} showEvent={false} />
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------- lobby

const PLAYER_STATUS: Record<GamePlayer["status"], string> = {
  pending: "Wants to join",
  registered: "Registered",
  playing: "Playing",
  waiting: "Waiting for next round",
  out: "Out",
  removed: "Kicked",
};

/** Open or closed lobby, join requests to let in, and kicking players. Live: re-read every few seconds. */
function LobbyPanel({ event, onChange }: { event: HubEvent; onChange: () => Promise<void> }) {
  const { data, error, reload } = useApi<GameLobby>(`/api/events/${event.id}/players`, 3000);
  const [shown, setShown] = useState<GameLobby | null>(null);
  const { busy, run } = useAction();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (data) setShown(data);
  }, [data]);
  const toggle = (discordId: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(discordId)) next.add(discordId);
      return next;
    });
  const details = (p: GamePlayer) => (
    <>
      {p.record && (
        <button className="link" onClick={() => toggle(p.discordId)}>
          {expanded.has(p.discordId) ? "Hide details" : "Details"}
        </button>
      )}
      {expanded.has(p.discordId) && <PlayerDetails p={p} locations={Boolean(shown?.locations)} />}
    </>
  );

  const change = (path: string, init: { method?: string; body: unknown }, label: string) =>
    run(async () => {
      setShown(await api<GameLobby>(path, init));
      await Promise.all([reload(), onChange()]);
    }, label);

  const setAccess = (access: LobbyAccess) => {
    if (!shown || access === shown.access) return;
    const waiting = shown.players.filter((p) => p.status === "pending").length;
    if (access === "open" && waiting && !confirm(`Open the lobby? The ${waiting} player${waiting === 1 ? "" : "s"} waiting will be let in.`)) return;
    void change(`/api/events/${event.id}/access`, { method: "PUT", body: { access } }, access === "open" ? "Lobby is open" : "Lobby is closed");
  };

  const act = (p: GamePlayer, action: PlayerAction) => {
    if (action === "kick" && !confirm(`Kick ${p.username} from "${event.name}"? They won't be able to join it again.`)) return;
    void change(
      `/api/events/${event.id}/players/${p.discordId}/${action}`,
      { body: {} },
      action === "approve" ? `${p.username} is in` : action === "deny" ? `Turned down ${p.username}` : `Kicked ${p.username}`,
    );
  };

  if (error && !shown)
    return (
      <section className="card">
        <h3>Lobby</h3>
        <p className="error">{error}</p>
      </section>
    );

  const players = shown?.players ?? [];
  const pending = players.filter((p) => p.status === "pending");
  const inEvent = players.filter((p) => p.status !== "pending");
  const active = inEvent.filter((p) => p.status === "registered" || p.status === "playing" || p.status === "waiting").length;

  return (
    <section className="card">
      <div className="row between">
        <h3>Lobby</h3>
        <span className="muted small">
          {active}
          {event.maxPlayers ? `/${event.maxPlayers}` : ""} {event.status === "running" ? "still in" : "registered"} · live
        </span>
      </div>
      {event.status === "registering" && (
        <div className="seg">
          <button className={shown?.access === "open" ? "active" : ""} disabled={busy || !shown} onClick={() => setAccess("open")}>
            Open
            <small>Anyone can join</small>
          </button>
          <button className={shown?.access === "closed" ? "active" : ""} disabled={busy || !shown} onClick={() => setAccess("closed")}>
            Closed
            <small>You approve each player</small>
          </button>
        </div>
      )}

      {pending.length > 0 && (
        <>
          <h4>Asking to join ({pending.length})</h4>
          <ul className="list">
            {pending.map((p) => (
              <li key={p.discordId}>
                <PlayerName p={p} />
                <button className="btn primary small-btn" disabled={busy} onClick={() => act(p, "approve")}>
                  Let in
                </button>
                <button className="btn ghost small-btn" disabled={busy} onClick={() => act(p, "deny")}>
                  Turn down
                </button>
                {details(p)}
              </li>
            ))}
          </ul>
        </>
      )}
      {shown?.access === "closed" && pending.length === 0 && event.status === "registering" && (
        <p className="muted small">Nobody is waiting. Players who ask to join show up here for you to let in.</p>
      )}

      <h4>Players ({inEvent.length})</h4>
      {!shown ? (
        <p className="muted">Asking {event.gameName}…</p>
      ) : inEvent.length === 0 ? (
        <Empty>Nobody has joined yet.</Empty>
      ) : (
        <ul className="list">
          {inEvent.map((p) => (
            <li key={p.discordId || p.username} className={p.status === "out" || p.status === "removed" ? "dim" : ""}>
              <PlayerName p={p} />
              <span className="muted small">{p.place !== null && p.status !== "removed" ? ordinal(p.place) : PLAYER_STATUS[p.status]}</span>
              {(p.status === "registered" || p.status === "playing" || p.status === "waiting") && p.discordId && (
                <button className="link danger" disabled={busy} onClick={() => act(p, "kick")}>
                  Kick
                </button>
              )}
              {details(p)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PlayerName({ p }: { p: GamePlayer }) {
  const where = p.record?.ips[0]?.location;
  return (
    <strong className="player">
      {p.online !== undefined && <span className={`dot ${p.online ? "on" : ""}`} title={p.online ? "On the game site now" : "Not on the game site"} />}
      {p.avatarUrl && <img src={p.avatarUrl} alt="" width={22} height={22} />}
      {p.username}
      {where?.countryCode && <span className="pill" title={placeName(where)}>{where.countryCode}</span>}
      {p.record?.sharedIpWith.length ? <span className="pill warnpill" title="Another account has used the same IP">Shared IP</span> : null}
    </strong>
  );
}

/** When a Discord account was made: it is encoded in the ID. */
const discordCreated = (id: string) => (/^\d{15,25}$/.test(id) ? Number((BigInt(id) >> 22n) + 1420070400000n) : null);

/** A day with its year: account ages matter (a brand-new account can be someone's second one). */
const fmtDate = (t: number | null) => (t ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—");

const placeName = (l: IpLocation) => (l.local ? "This PC or a private network" : [l.city, l.region, l.country].filter(Boolean).join(", ") || "Unknown place");

/** Everything the game and the hub know about a player. */
function PlayerDetails({ p, locations }: { p: GamePlayer; locations: boolean }) {
  const r = p.record!;
  const created = discordCreated(p.discordId);
  return (
    <dl className="player-details">
      <dt>Discord</dt>
      <dd>
        <span className="mono">{p.discordId}</span>
        {created && <span className="muted"> · account made {fmtDate(created)}</span>}
      </dd>
      {p.joinedAt && (
        <>
          <dt>{p.status === "pending" ? "Asked to join" : "Joined this event"}</dt>
          <dd>{fmtAgo(p.joinedAt)}</dd>
        </>
      )}
      <dt>On the game site</dt>
      <dd>
        {p.online ? <span className="ok">Online now</span> : <>Last seen {fmtAgo(r.lastVisit)}</>}
        <span className="muted"> · first visit {fmtDate(r.firstVisit)}</span>
      </dd>
      <dt>IP addresses</dt>
      <dd>
        {r.ips.length === 0 ? (
          <span className="muted">None recorded yet</span>
        ) : (
          <ul>
            {r.ips.map((i) => (
              <li key={i.ip}>
                <span className="mono">{i.ip}</span>
                {i.location ? (
                  <>
                    {" "}
                    · {placeName(i.location)}
                    {i.location.network && <span className="muted"> · {i.location.network}</span>}
                  </>
                ) : null}
                <span className="muted"> · last used {fmtAgo(i.lastSeen)}</span>
              </li>
            ))}
          </ul>
        )}
        {!locations && r.ips.length > 0 && <small className="muted">Locations appear once the IP location database is installed (see SETUP.md).</small>}
        {locations && r.ips.length > 0 && (
          <small className="muted">
            <a href="https://db-ip.com" target="_blank" rel="noreferrer">IP Geolocation by DB-IP</a>
          </small>
        )}
      </dd>
      {r.sharedIpWith.length > 0 && (
        <>
          <dt>Same IP as</dt>
          <dd className="warn">{r.sharedIpWith.map((o) => o.username).join(", ")}</dd>
        </>
      )}
    </dl>
  );
}

function LadderView({ rules }: { rules: PrizeRule[] }) {
  const { prizes } = useHub();
  return (
    <ul className="list">
      {rules.map((r, i) => {
        const p = prizes.find((x) => x.id === r.prizeId);
        return (
          <li key={i}>
            <span className="place-tag">{placeLabel(r.placeFrom, r.placeTo)}</span>
            <span>{p?.name ?? "Deleted prize"}</span>
            {p?.type === "code_pool" && <span className={`small ${p.stock < r.placeTo - r.placeFrom + 1 ? "warn" : "muted"}`}>{p.stock} code{p.stock === 1 ? "" : "s"} in stock</span>}
          </li>
        );
      })}
    </ul>
  );
}

export function AwardTable({ awards, onChange, showEvent = true }: { awards: Award[]; onChange: () => void; showEvent?: boolean }) {
  const { busy, run } = useAction();
  const act = (a: Award, action: "resend" | "cancel" | "manual", label: string) => {
    if (action === "cancel" && !confirm(`Cancel ${a.prizeName} for ${a.username}?`)) return;
    void run(async () => {
      await api(`/api/awards/${a.id}/${action}`, { body: {} });
      onChange();
    }, label);
  };
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Place</th>
          <th>Winner</th>
          {showEvent && <th>Event</th>}
          <th>Prize</th>
          <th>Status</th>
          <th>When</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {awards.map((a) => (
          <tr key={a.id}>
            <td>{ordinal(a.place)}</td>
            <td>
              {a.username} <span className="muted small mono">{a.discordId}</span>
            </td>
            {showEvent && (
              <td>
                <a href={`#/events/${a.eventId}`}>{a.eventName}</a>
              </td>
            )}
            <td>{a.prizeName}</td>
            <td>
              <AwardStatusPill status={a.status} />
              {a.lastError && a.status !== "sent" && <div className="small muted">{a.lastError}</div>}
            </td>
            <td className="muted small">{fmtAgo(a.sentAt ?? a.createdAt)}</td>
            <td className="actions">
              {(a.status === "dm_failed" || a.status === "sent") && (
                <button className="link" disabled={busy} onClick={() => act(a, "resend", "Resending")}>
                  Resend
                </button>
              )}
              {a.status === "dm_failed" && (
                <button className="link" disabled={busy} onClick={() => act(a, "manual", "Marked as delivered")}>
                  Delivered by hand
                </button>
              )}
              {(a.status === "pending" || a.status === "waiting_stock" || a.status === "dm_failed") && (
                <button className="link danger" disabled={busy} onClick={() => act(a, "cancel", "Cancelled")}>
                  Cancel
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
