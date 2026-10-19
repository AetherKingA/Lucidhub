import { useEffect, useRef, useState } from "react";
import type { Card, ClientAction, Color, SeatView, TableView } from "../shared/protocol.ts";
import { COLOR_CLASS, COLOR_LABEL, CardBack, UnoCard } from "./Cards.tsx";
import { TableChat } from "./Chat.tsx";
import { tableKey, useGame, useServerNow } from "./game.tsx";
import { LiveTables, useTournamentDetail } from "./TournamentPage.tsx";

export function TablePage({ tournamentId, tableId }: { tournamentId: number; tableId: number }) {
  const { tables, chats, spectatorChats, viewers, follows, send, tournaments, status, user } = useGame();
  const k = tableKey(tournamentId, tableId);
  const view = tables[k];
  const summary = tournaments.find((t) => t.id === tournamentId);
  const [sound, setSound] = usePref("uno:sound", true);
  // On narrow screens the chat covers the table, so it starts closed there.
  const [chatOpen, setChatOpen] = usePref("uno:chat", typeof innerWidth === "number" && innerWidth >= 1100);
  const messages = chats[k] ?? [];
  const spectatorMessages = spectatorChats[k] ?? [];
  const seated = view?.mySeat != null;
  const unread = useUnread(messages.length + (seated ? 0 : spectatorMessages.length), chatOpen);
  const watching = viewers[k] ?? 0;
  const following = follows[tournamentId] ?? null;
  const me = summary?.me;
  const stillPlaying = Boolean(me && ((me.registered && me.place === null) || me.pending));
  // Spectators who are out of (or never in) a running tournament can follow a player around.
  const canFollow = Boolean(view && !seated && !stillPlaying && summary?.status === "running");
  const follow = (userId: number | null) => send({ type: "follow", tournamentId, userId });
  // The list of other tables, for when this one has finished.
  const { detail } = useTournamentDetail(tournamentId, !view);

  // Subscribe while this page is open (own table is subscribed automatically anyway).
  useEffect(() => {
    if (status !== "open") return;
    send({ type: "watch", tournamentId, tableId });
    return () => send({ type: "watch", tournamentId, tableId: null });
  }, [tournamentId, tableId, status]);

  const myTable = summary?.me?.tableId;
  return (
    <main className={`table-page ${chatOpen ? "chat-open" : ""}`}>
      <div className="table-main">
        <div className="table-head">
          <a className="back" href={`#/t/${tournamentId}`}>
            ← {summary?.name ?? "Tournament"}
          </a>
          <span className="table-name">Table {tableId}</span>
          {view && (
            <span className="level-clock">
              <span className="lc-pill">{view.round === view.totalRounds ? "Final table" : `Round ${view.round}/${view.totalRounds}`}</span>
              <span className="lc-pill">
                Hand #{view.handNo} · first to <b>{view.winsToAdvance}</b>
              </span>
              {view.stacking && <span className="lc-pill muted">Stacking on</span>}
              <span className="lc-pill muted">{summary?.remaining ?? 0} left</span>
            </span>
          )}
          {watching > 0 && (
            <span className="lc-pill muted" title="People watching this table">
              👁 {watching} watching
            </span>
          )}
          {following && (
            <span className="lc-pill follow-chip">
              Following <b>{following.username}</b>
              <button className="link" onClick={() => follow(null)} title="Stop following">
                ✕
              </button>
            </span>
          )}
          <span className="head-tools">
            {myTable != null && myTable !== tableId && (
              <a className="btn primary small-btn" href={`#/t/${tournamentId}/table/${myTable}`}>
                Back to my table
              </a>
            )}
            <button className="icon-btn" onClick={() => setSound(!sound)} title={sound ? "Mute your-turn sound" : "Play a sound on your turn"}>
              {sound ? "🔔" : "🔕"}
            </button>
            <button className="icon-btn chat-toggle" onClick={() => setChatOpen(!chatOpen)} title={chatOpen ? "Hide chat" : "Show chat"}>
              💬{!chatOpen && unread > 0 && <span className="unread">{unread > 9 ? "9+" : unread}</span>}
            </button>
          </span>
        </div>
        {view?.hostView && <div className="host-banner">👁 Host view: you can see every hand. Don't share what you see with players.</div>}
        {view && !seated && user.isAdmin && stillPlaying && <div className="host-banner muted">Host view is off while you're playing in this tournament.</div>}
        {!view ? (
          <div className="center muted table-empty">
            <p>
              {summary?.me?.place === 1
                ? "🏆 You won the tournament!"
                : summary?.me?.waiting
                  ? `You won this table! You'll move to your round ${summary.me.waiting.round} table when the rest of your group finishes (${summary.me.waiting.groupDone}/${summary.me.waiting.groupSize} tables done).`
                  : summary?.status === "finished" || summary?.status === "cancelled"
                    ? "This tournament is over."
                    : following?.tableId === null
                      ? `Waiting for ${following.username}'s next table (round ${following.round})…`
                      : "This table has finished (or is loading)."}
            </p>
            {following?.tableId != null && following.tableId !== tableId && (
              <a className="btn primary" href={`#/t/${tournamentId}/table/${following.tableId}`}>
                Go to {following.username}'s table
              </a>
            )}
            {summary?.status === "running" && detail && detail.tables.length > 0 && (
              <>
                <p className="small">Watch another table:</p>
                <LiveTables t={summary} tables={detail.tables} except={tableId} />
              </>
            )}
          </div>
        ) : (
          <Table view={view} sound={sound} followingId={following?.userId ?? null} onFollow={canFollow ? follow : null} />
        )}
      </div>
      {chatOpen && (
        <aside className="chat-panel">
          <TableChat
            tournamentId={tournamentId}
            tableId={tableId}
            messages={messages}
            spectatorMessages={spectatorMessages}
            seated={seated}
            canSend={Boolean(view)}
            onClose={() => setChatOpen(false)}
          />
        </aside>
      )}
    </main>
  );
}

/** A remembered on/off preference (sound, chat panel). */
function usePref(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? fallback : s === "1";
    } catch {
      return fallback;
    }
  });
  const set = (next: boolean) => {
    setV(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      /* private mode */
    }
  };
  return [v, set];
}

/** Messages that arrived while the chat panel was closed. */
function useUnread(count: number, open: boolean) {
  const seen = useRef(count);
  if (open) seen.current = count;
  return Math.max(0, count - seen.current);
}

function useTurnSound(myTurn: boolean, enabled: boolean, turnKey: string) {
  const ctx = useRef<AudioContext | null>(null);
  useEffect(() => {
    if (!myTurn || !enabled) return;
    try {
      ctx.current ??= new AudioContext();
      const ac = ctx.current;
      const now = ac.currentTime;
      for (const [i, freq] of [660, 880].entries()) {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = "sine";
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, now + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.12, now + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.25);
        o.connect(g).connect(ac.destination);
        o.start(now + i * 0.12);
        o.stop(now + i * 0.12 + 0.3);
      }
    } catch {
      /* no audio */
    }
  }, [myTurn, enabled, turnKey]);
}

/** Seat positions around the oval (percent), starting bottom-center and going clockwise. */
function seatPosition(i: number, n: number) {
  const angle = Math.PI / 2 + (i / n) * Math.PI * 2;
  return { left: 50 + 46 * Math.cos(angle), top: 50 + 42 * Math.sin(angle) };
}

function Table(p: { view: TableView; sound: boolean; followingId: number | null; onFollow: ((userId: number | null) => void) | null }) {
  const { view, sound } = p;
  const { send } = useGame();
  const me = view.mySeat !== null ? view.seats[view.mySeat]! : null;
  const myTurn = view.legal !== null;
  useTurnSound(myTurn, sound, `${view.handNo}:${view.events.length}:${view.events.at(-1) ?? ""}`);

  const act = (action: ClientAction) => send({ type: "action", tournamentId: view.tournamentId, action });
  const n = view.tableSize;
  // Rotate the table so you sit at the bottom.
  const offset = view.mySeat ?? 0;
  const winner = view.handWinnerSeat !== null ? view.seats[view.handWinnerSeat] : null;

  return (
    <>
      <div className="felt-wrap">
        <div className="uno-table">
          <div className={`table-glow ${view.color ? COLOR_CLASS[view.color] : ""}`} />
          {view.seats.map((s, i) => {
            if (!s || i === view.mySeat) return null;
            const pos = seatPosition((i - offset + n) % n, n);
            return (
              <div key={i} className="seat-slot" style={{ left: `${pos.left}%`, top: `${pos.top}%` }}>
                <Seat
                  s={s}
                  view={view}
                  canCatch={me !== null && s.catchable}
                  onCatch={() => act({ type: "catch", seat: s.seat })}
                  followed={p.followingId === s.userId}
                  onFollow={p.onFollow}
                />
              </div>
            );
          })}
          <div className="table-center">
            <Pile view={view} myTurn={myTurn} onDraw={() => act({ type: "draw" })} />
            <ul className="events" aria-live="polite">
              {view.events.slice(-3).map((e, i, arr) => (
                <li key={`${view.handNo}-${view.events.length}-${i}`} className={i === arr.length - 1 ? "latest" : ""}>
                  {e}
                </li>
              ))}
            </ul>
          </div>
          {view.handComplete && winner && (
            <div className="hand-banner">
              <b>{winner.seat === view.mySeat ? "You win the hand!" : `${winner.username} wins the hand!`}</b>
              <span>
                {winner.wins + 1}/{view.winsToAdvance} hands
                {winner.wins + 1 >= view.winsToAdvance ? " · wins the table" : ""}
              </span>
            </div>
          )}
          {view.paused && <div className="hand-banner paused">⏸ Paused</div>}
        </div>
      </div>
      {me ? <MyArea view={view} me={me} act={act} /> : <div className="spectating muted">You're watching this table.</div>}
    </>
  );
}

function Pile({ view, myTurn, onDraw }: { view: TableView; myTurn: boolean; onDraw: () => void }) {
  const canDraw = myTurn && Boolean(view.legal?.canDraw);
  const pending = view.pendingDraw;
  return (
    <div className="piles">
      <button
        type="button"
        className={`draw-pile ${canDraw ? "can" : ""} ${canDraw && !view.legal?.playable.length ? "nudge" : ""}`}
        onClick={canDraw ? onDraw : undefined}
        disabled={!canDraw}
        title={canDraw ? (pending ? `Draw ${pending}` : "Draw a card") : `${view.drawPileCount} cards left`}
      >
        <CardBack size="lg" style={{ transform: "translate(4px, 4px)" }} />
        <CardBack size="lg" style={{ transform: "translate(2px, 2px)" }} />
        <CardBack size="lg" />
        {canDraw && <span className="draw-label">{pending ? `Draw ${pending}` : "Draw"}</span>}
      </button>
      <div className="discard">
        {view.topCard && <UnoCard key={`${view.handNo}-${view.events.length}`} card={view.topCard} size="lg" />}
        {view.color && (
          <span className={`current-color ${COLOR_CLASS[view.color]}`} title={`Current color: ${COLOR_LABEL[view.color]}`}>
            {COLOR_LABEL[view.color]}
          </span>
        )}
      </div>
      <span className={`direction ${view.direction === 1 ? "cw" : "ccw"}`} title={view.direction === 1 ? "Play goes clockwise" : "Play goes counter-clockwise"}>
        ↻
      </span>
      {pending > 0 && <span className="pending-badge">+{pending}</span>}
    </div>
  );
}

function WinPips({ wins, of }: { wins: number; of: number }) {
  return (
    <span className="pips" title={`${wins} of ${of} hands won`}>
      {Array.from({ length: of }, (_, i) => (
        <i key={i} className={i < wins ? "on" : ""} />
      ))}
    </span>
  );
}

function Seat(p: {
  s: SeatView;
  view: TableView;
  canCatch: boolean;
  onCatch: () => void;
  followed: boolean;
  onFollow: ((userId: number | null) => void) | null;
}) {
  const { s, view, canCatch, onCatch, followed, onFollow } = p;
  const acting = view.toActSeat === s.seat;
  const winner = view.handWinnerSeat === s.seat;
  const backs = Math.min(s.cardCount, 8);
  const fan = (i: number, n: number) => ({ transform: `rotate(${(i - (n - 1) / 2) * 9}deg) translateY(${Math.abs(i - (n - 1) / 2) * 2}px)` });
  return (
    <div className={`seat ${acting ? "acting" : ""} ${winner ? "winner" : ""} ${s.away ? "away" : ""}`}>
      {s.hand ? (
        // Host view: the real cards, face up.
        <div className="fan face-up" aria-label={`${s.cardCount} cards`}>
          {s.hand.map((c, i) => (
            <UnoCard key={`${i}-${c}`} card={c} size="sm" style={fan(i, s.hand!.length)} />
          ))}
          {s.cardCount > 0 && <span className="count">{s.cardCount}</span>}
        </div>
      ) : (
        <div className="fan" aria-label={`${s.cardCount} cards`}>
          {Array.from({ length: backs }, (_, i) => (
            <CardBack key={i} size="xs" style={fan(i, backs)} />
          ))}
          {s.cardCount > 0 && <span className="count">{s.cardCount}</span>}
        </div>
      )}
      <div className="plate">
        <span className="avatar-wrap">
          <img className="avatar" src={s.avatarUrl} alt="" width={36} height={36} />
          {acting && <TurnRing view={view} />}
        </span>
        <span className="plate-text">
          <span className="name">{s.username}</span>
          <WinPips wins={s.wins} of={view.winsToAdvance} />
        </span>
      </div>
      {(s.cardCount === 1 && s.calledUno) && <span className="tag uno">UNO!</span>}
      {canCatch && (
        <button className="btn catch" onClick={onCatch}>
          Catch!
        </button>
      )}
      {!s.connected && <span className="tag">offline</span>}
      {s.connected && s.away && <span className="tag">away</span>}
      {s.handPoints !== null && <span className="tag points">+{s.handPoints} pts</span>}
      {onFollow && (
        <button
          className={`follow-btn ${followed ? "on" : ""}`}
          onClick={() => onFollow(followed ? null : s.userId)}
          title={followed ? "Stop following" : `Follow ${s.username} to every table they play at`}
        >
          {followed ? "★ Following" : "☆ Follow"}
        </button>
      )}
    </div>
  );
}

function TurnRing({ view }: { view: TableView }) {
  const now = useServerNow(100);
  if (view.actionStartedAt === null || view.actionDeadline === null) return null;
  const normalEnd = view.actionStartedAt + view.decisionMs;
  const inBank = now > normalEnd;
  const frac = view.paused
    ? 1
    : inBank
      ? (view.actionDeadline - now) / Math.max(1, view.actionDeadline - normalEnd)
      : (normalEnd - now) / view.decisionMs;
  const f = Math.max(0, Math.min(1, frac));
  const C = 2 * Math.PI * 25;
  return (
    <svg className={`turn-ring ${inBank ? "bank" : ""}`} viewBox="0 0 56 56" aria-hidden="true">
      <circle cx="28" cy="28" r="25" className="track" />
      <circle cx="28" cy="28" r="25" className="fill" strokeDasharray={C} strokeDashoffset={C * (1 - f)} />
    </svg>
  );
}

function TurnTimer({ view }: { view: TableView }) {
  const now = useServerNow(250);
  if (view.actionDeadline === null || view.actionStartedAt === null || view.paused) return null;
  const normalEnd = view.actionStartedAt + view.decisionMs;
  const inBank = now > normalEnd;
  const left = Math.max(0, Math.ceil(((inBank ? view.actionDeadline : normalEnd) - now) / 1000));
  return <span className={`turn-timer ${inBank ? "bank" : ""} ${left <= 5 ? "low" : ""}`}>{inBank ? `Time bank ${left}s` : `${left}s`}</span>;
}

/** Your hand and controls along the bottom. */
function MyArea({ view, me, act }: { view: TableView; me: SeatView; act: (a: ClientAction) => void }) {
  const { send } = useGame();
  const [picking, setPicking] = useState<Card | null>(null);
  const legal = view.legal;
  const playable = new Set(legal?.playable ?? []);
  const myTurn = legal !== null;
  const hand = view.myHand;

  // Close the color picker if the turn moved on (timed out, paused…).
  useEffect(() => {
    if (!myTurn) setPicking(null);
  }, [myTurn]);

  const play = (card: Card, color?: Color) => {
    setPicking(null);
    act({ type: "play", card, ...(color ? { color } : {}) });
  };
  const onCard = (card: Card) => {
    if (!playable.has(card)) return;
    if (card === "W" || card === "W4") setPicking(card);
    else play(card);
  };

  // Overlap the cards more as the hand grows, so it always fits.
  const overlap = hand.length <= 7 ? 0.35 : Math.min(0.75, 0.35 + (hand.length - 7) * 0.04);
  // Keys that survive other cards leaving the hand ("r7", "r7#2"), so only new cards animate in.
  const seen = new Map<Card, number>();
  const keys = hand.map((c) => {
    const n = (seen.get(c) ?? 0) + 1;
    seen.set(c, n);
    return n === 1 ? c : `${c}#${n}`;
  });

  return (
    <div className={`my-area ${myTurn ? "my-turn" : ""} ${view.handWinnerSeat === me.seat ? "won" : ""}`}>
      {me.away && (
        <div className="away-bar">
          You ran out of time, so the game is playing for you.
          <button className="btn primary" onClick={() => send({ type: "back", tournamentId: view.tournamentId })}>
            I'm back
          </button>
        </div>
      )}
      <div className="my-bar">
        <span className="my-info">
          <img className="avatar" src={me.avatarUrl} alt="" width={32} height={32} />
          <b>You</b>
          <WinPips wins={me.wins} of={view.winsToAdvance} />
          {myTurn ? (
            <span className="your-turn">
              {legal!.pendingDraw > 0 ? `Stack a draw card or draw ${legal!.pendingDraw}` : legal!.drawn ? "Play the card you drew, or pass" : "Your turn"}
              <TurnTimer view={view} />
            </span>
          ) : view.handComplete ? null : (
            <span className="muted small">Waiting for {view.toActSeat !== null ? view.seats[view.toActSeat]?.username : "…"}</span>
          )}
        </span>
        <span className="my-buttons">
          {legal?.canPass && (
            <button className="btn" onClick={() => act({ type: "pass" })}>
              Pass
            </button>
          )}
          {legal?.canDraw && (
            <button className="btn" onClick={() => act({ type: "draw" })}>
              {legal.pendingDraw ? `Draw ${legal.pendingDraw}` : "Draw"}
            </button>
          )}
          <button
            className={`btn uno-btn ${view.canCallUno && hand.length <= 2 ? "ready" : ""} ${me.calledUno ? "called" : ""}`}
            onClick={() => act({ type: "uno" })}
            disabled={!view.canCallUno}
            title="Call UNO when you're about to have one card left"
          >
            {me.calledUno ? "UNO ✓" : "UNO!"}
          </button>
        </span>
      </div>
      <div className="hand" style={{ ["--overlap" as string]: overlap }}>
        {hand.map((c, i) => (
          <UnoCard
            key={keys[i]}
            card={c}
            size="lg"
            playable={myTurn && playable.has(c)}
            dim={myTurn && !playable.has(c)}
            onClick={myTurn ? () => onCard(c) : undefined}
            style={{ zIndex: i }}
          />
        ))}
        {!hand.length && <span className="muted">{view.handComplete ? "" : "Dealing…"}</span>}
      </div>
      {picking && (
        <div className="color-picker" role="dialog" aria-label="Pick a color">
          <span>Pick a color</span>
          <div className="swatches">
            {(["r", "y", "g", "b"] as Color[]).map((c) => (
              <button key={c} className={`swatch ${COLOR_CLASS[c]}`} onClick={() => play(picking, c)}>
                {COLOR_LABEL[c]}
              </button>
            ))}
          </div>
          <button className="link" onClick={() => setPicking(null)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
