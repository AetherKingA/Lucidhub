import { useEffect, useRef, useState } from "react";
import type { ClientAction, Color, SeatView, TableView } from "../shared/protocol.ts";
import { TableChat } from "./Chat.tsx";
import { formatClock, ordinal, tableKey, useGame, useServerNow } from "./game.tsx";
import { LiveTables, useTournamentDetail } from "./TournamentPage.tsx";

export function TablePage({ tournamentId, tableId }: { tournamentId: number; tableId: number }) {
  const { tables, chats, spectatorChats, viewers, follows, send, tournaments, status } = useGame();
  const k = tableKey(tournamentId, tableId);
  const view = tables[k];
  const summary = tournaments.find((t) => t.id === tournamentId);
  const [sound, setSound] = usePref("chess:sound", true);
  // Spectators choose which side is at the bottom (players always play from the bottom).
  const [flipped, setFlipped] = usePref("chess:flip", false);
  // On narrow screens the chat covers the board, so it starts closed there.
  const [chatOpen, setChatOpen] = usePref("chess:chat", typeof innerWidth === "number" && innerWidth >= 1300);
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
  // The list of other boards, for when this match has finished.
  const { detail } = useTournamentDetail(tournamentId, !view);

  // Subscribe while this page is open (own board is subscribed automatically anyway).
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
          <span className="table-name">Board {tableId}</span>
          {view && (
            <span className="level-clock">
              <span className="lc-pill">{view.round === view.totalRounds ? "Final" : `Round ${view.round}/${view.totalRounds}`}</span>
              <span className="lc-pill">
                Game {Math.max(1, view.gameNo)} · first to <b>{view.winsToAdvance}</b>
              </span>
              <span className="lc-pill muted">
                {view.minutes}+{view.incrementSeconds}
              </span>
              {view.armageddon && <span className="lc-pill">Armageddon</span>}
              <span className="lc-pill muted">{summary?.remaining ?? 0} left</span>
            </span>
          )}
          {watching > 0 && (
            <span className="lc-pill muted" title="People watching this board">
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
                Back to my board
              </a>
            )}
            {view && !seated && (
              <button className="icon-btn" onClick={() => setFlipped(!flipped)} title={flipped ? "Show White at the bottom" : "Show Black at the bottom"}>
                ⇅
              </button>
            )}
            <button className="icon-btn" onClick={() => setSound(!sound)} title={sound ? "Mute move sounds" : "Play move sounds"}>
              {sound ? "🔔" : "🔕"}
            </button>
            <button className="icon-btn chat-toggle" onClick={() => setChatOpen(!chatOpen)} title={chatOpen ? "Hide chat" : "Show chat"}>
              💬{!chatOpen && unread > 0 && <span className="unread">{unread > 9 ? "9+" : unread}</span>}
            </button>
          </span>
        </div>
        {!view ? (
          <div className="center muted table-empty">
            <p>
              {summary?.me?.place === 1
                ? "🏆 You won the tournament!"
                : summary?.me?.waiting
                  ? `You're through to round ${summary.me.waiting.round}! Your next match starts when the other match in your half of the bracket finishes.`
                  : summary?.status === "finished" || summary?.status === "cancelled"
                    ? "This tournament is over."
                    : following?.tableId === null
                      ? `Waiting for ${following.username}'s next match (round ${following.round})…`
                      : summary?.me?.place != null
                        ? `Your tournament is over: you finished ${ordinal(summary.me.place)}. You can still watch the other boards.`
                        : "This match has finished (or is loading)."}
            </p>
            {following?.tableId != null && following.tableId !== tableId && (
              <a className="btn primary" href={`#/t/${tournamentId}/table/${following.tableId}`}>
                Go to {following.username}'s board
              </a>
            )}
            {summary?.status === "running" && detail && detail.tables.length > 0 && (
              <>
                <p className="small">Watch another board:</p>
                <LiveTables t={summary} tables={detail.tables} totalRounds={detail.rounds.length} except={tableId} />
              </>
            )}
          </div>
        ) : (
          <Match view={view} sound={sound} flipped={flipped} followingId={following?.userId ?? null} onFollow={canFollow ? follow : null} />
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

/** A short click for each move; a little higher when it's now your turn. */
function useMoveSound(moveCount: number, myTurn: boolean, enabled: boolean, gameNo: number) {
  const ctx = useRef<AudioContext | null>(null);
  const last = useRef({ moveCount, gameNo });
  useEffect(() => {
    const prev = last.current;
    last.current = { moveCount, gameNo };
    if (!enabled || prev.gameNo !== gameNo || moveCount <= prev.moveCount) return;
    try {
      ctx.current ??= new AudioContext();
      const ac = ctx.current;
      const now = ac.currentTime;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = "triangle";
      o.frequency.value = myTurn ? 880 : 520;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.15, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
      o.connect(g).connect(ac.destination);
      o.start(now);
      o.stop(now + 0.15);
    } catch {
      /* no audio */
    }
  }, [moveCount, gameNo, enabled, myTurn]);
}

// ------------------------------------------------------------------ pieces and squares

const GLYPH: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟︎" };
const NAME: Record<string, string> = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
const FILES = "abcdefgh";
const sqName = (sq: number) => `${FILES[sq & 7]}${(sq >> 3) + 1}`;
const pieceColor = (p: string): Color => (p === p.toUpperCase() ? "w" : "b");

function Piece({ p }: { p: string }) {
  const t = p.toLowerCase();
  return (
    <span className={`piece ${pieceColor(p)}`} aria-hidden="true">
      {GLYPH[t]}
    </span>
  );
}

// ------------------------------------------------------------------ the match

function Match(p: { view: TableView; sound: boolean; flipped: boolean; followingId: number | null; onFollow: ((userId: number | null) => void) | null }) {
  const { view, sound } = p;
  const { send } = useGame();
  const act = (action: ClientAction) => send({ type: "action", tournamentId: view.tournamentId, action });
  const myTurn = view.legal.length > 0;
  useMoveSound(view.moves.length, myTurn, sound, view.gameNo);

  // You play from the bottom; spectators see White at the bottom unless they flip the board.
  const bottomColor: Color = view.myColor ?? (p.flipped ? "b" : "w");
  const seats = view.seats.filter((s): s is SeatView => s !== null);
  const bottom = seats.find((s) => s.color === bottomColor) ?? (view.mySeat !== null ? view.seats[view.mySeat] : seats[0]) ?? null;
  const top = seats.find((s) => s !== bottom) ?? null;
  const strip = (s: SeatView | null) => <PlayerStrip s={s} view={view} followed={s !== null && p.followingId === s.userId} onFollow={p.onFollow} />;

  return (
    <div className="match">
      <div className="board-col">
        {strip(top)}
        <Board view={view} bottomColor={bottomColor} onMove={(uci) => act({ type: "move", uci })} />
        {strip(bottom)}
      </div>
      <div className="side-col">
        <MatchScore view={view} />
        <Controls view={view} act={act} />
        <MoveList moves={view.moves} />
      </div>
    </div>
  );
}

function WinPips({ wins, of }: { wins: number; of: number }) {
  return (
    <span className="pips" title={`${wins} of ${of} wins needed`}>
      {Array.from({ length: of }, (_, i) => (
        <i key={i} className={i < wins ? "on" : ""} />
      ))}
    </span>
  );
}

function PlayerStrip(p: { s: SeatView | null; view: TableView; followed: boolean; onFollow: ((userId: number | null) => void) | null }) {
  const { s, view, followed, onFollow } = p;
  if (!s) return <div className="player-strip muted">Waiting for an opponent…</div>;
  const isMe = view.mySeat === s.seat;
  return (
    <div className="player-strip">
      <img className="avatar" src={s.avatarUrl} alt="" width={36} height={36} />
      <span className="who">
        <span className="name">
          {s.color && <span className={`color-dot ${s.color}`} title={s.color === "w" ? "White" : "Black"} />}
          {isMe ? "You" : s.username}
          {!s.connected && <span className="tag">offline</span>}
        </span>
        <span className="sub">
          <WinPips wins={s.wins} of={view.winsToAdvance} />
          {s.draws > 0 && (
            <span>
              {s.draws} draw{s.draws === 1 ? "" : "s"}
            </span>
          )}
          {onFollow && (
            <button
              className={`follow-btn ${followed ? "on" : ""}`}
              onClick={() => onFollow(followed ? null : s.userId)}
              title={followed ? "Stop following" : `Follow ${s.username} to every board they play at`}
            >
              {followed ? "★ Following" : "☆ Follow"}
            </button>
          )}
        </span>
      </span>
      {s.color && <Clock view={view} color={s.color} />}
    </div>
  );
}

function Clock({ view, color }: { view: TableView; color: Color }) {
  const now = useServerNow(100);
  const toMove = !view.result && view.board.length > 0 && view.turn === color;
  if (toMove && view.firstMoveDeadline !== null) {
    const left = view.paused ? null : Math.max(0, Math.ceil((view.firstMoveDeadline - now) / 1000));
    return <span className={`chess-clock first ${left !== null && left <= 10 ? "low" : "running"}`}>{left === null ? "First move" : `Move in ${left}s`}</span>;
  }
  const running = toMove && view.turnStartedAt !== null && !view.paused;
  const ms = running ? view.clocks[color] - (now - view.turnStartedAt!) : view.clocks[color];
  const low = ms < 10_000;
  // Under 20 seconds, show tenths.
  const text = ms < 20_000 ? `${Math.floor(Math.max(0, ms) / 1000)}.${Math.floor((Math.max(0, ms) % 1000) / 100)}` : formatClock(ms);
  return <span className={`chess-clock ${running ? "running" : ""} ${low && view.board.length ? "low" : ""}`}>{text}</span>;
}

function Board({ view, bottomColor, onMove }: { view: TableView; bottomColor: Color; onMove: (uci: string) => void }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [promo, setPromo] = useState<{ from: number; to: number } | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const legal = view.legal;
  const board = view.board.length ? view.board : null;

  // Forget the selection when the position changes (a move was played, a new game started…).
  const positionKey = `${view.gameNo}:${view.moves.length}`;
  useEffect(() => {
    setSelected(null);
    setPromo(null);
  }, [positionKey]);

  const fromSquares = new Set(legal.map((u) => squareOf(u.slice(0, 2))));
  const targets = new Map<number, string[]>();
  if (selected !== null) for (const u of legal) if (squareOf(u.slice(0, 2)) === selected) targets.set(squareOf(u.slice(2, 4)), [...(targets.get(squareOf(u.slice(2, 4))) ?? []), u]);

  const tryMove = (from: number, to: number) => {
    const options = legal.filter((u) => squareOf(u.slice(0, 2)) === from && squareOf(u.slice(2, 4)) === to);
    if (!options.length) return false;
    if (options.length > 1) setPromo({ from, to });
    else onMove(options[0]!);
    setSelected(null);
    return true;
  };

  const onSquare = (sq: number) => {
    if (selected !== null && tryMove(selected, sq)) return;
    setSelected(fromSquares.has(sq) && sq !== selected ? sq : null);
  };

  // Rows from the top of the screen: rank 8 first when White is at the bottom.
  const order: number[] = [];
  for (let row = 0; row < 8; row++)
    for (let col = 0; col < 8; col++) {
      const rank = bottomColor === "w" ? 7 - row : row;
      const file = bottomColor === "w" ? col : 7 - col;
      order.push(rank * 8 + file);
    }

  const result = view.result;
  const winner = (result && result.winnerSeat !== null ? view.seats[result.winnerSeat] : null) ?? null;
  const myColor = view.myColor;

  return (
    <div className="board-wrap">
      <div className="board" role="grid" aria-label="Chess board">
        {order.map((sq, i) => {
          const p = board?.[sq] ?? "";
          const light = ((sq & 7) + (sq >> 3)) % 2 === 1;
          const row = Math.floor(i / 8);
          const col = i % 8;
          const isTarget = targets.has(sq);
          const cls = [
            "sq",
            light ? "light" : "dark",
            view.lastMove && (view.lastMove.from === sq || view.lastMove.to === sq) ? "last" : "",
            selected === sq ? "sel" : "",
            view.checkSquare === sq ? "check" : "",
            isTarget ? "target" : "",
            isTarget && p ? "capture" : "",
            fromSquares.has(sq) ? "movable" : "",
            dragOver === sq ? "drop-hover" : "",
          ].join(" ");
          const label = `${sqName(sq)}${p ? `, ${pieceColor(p) === "w" ? "white" : "black"} ${NAME[p.toLowerCase()]}` : ""}`;
          return (
            <button
              key={sq}
              type="button"
              className={cls}
              aria-label={label}
              onClick={() => onSquare(sq)}
              draggable={fromSquares.has(sq)}
              onDragStart={(e) => {
                setSelected(sq);
                e.dataTransfer.setData("text/plain", String(sq));
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (selected !== null && targets.has(sq)) {
                  e.preventDefault();
                  setDragOver(sq);
                }
              }}
              onDragLeave={() => setDragOver((d) => (d === sq ? null : d))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const from = Number(e.dataTransfer.getData("text/plain"));
                if (Number.isInteger(from)) tryMove(from, sq);
              }}
              onDragEnd={() => setDragOver(null)}
            >
              {p && <Piece p={p} />}
              {col === 0 && <span className="coord rank">{(sq >> 3) + 1}</span>}
              {row === 7 && <span className="coord file">{FILES[sq & 7]}</span>}
            </button>
          );
        })}
      </div>
      {promo && (
        <div className="promo-picker" role="dialog" aria-label="Choose a piece">
          <div>
            <span>Promote to</span>
            <span className="choices">
              {(["q", "r", "b", "n"] as const).map((t) => (
                <button key={t} type="button" title={NAME[t]} onClick={() => (setPromo(null), onMove(`${sqName(promo.from)}${sqName(promo.to)}${t}`))}>
                  <Piece p={myColor === "w" ? t.toUpperCase() : t} />
                </button>
              ))}
            </span>
            <button className="link" onClick={() => setPromo(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {result && (
        <div className="board-banner">
          <b>
            {winner === null
              ? "Draw"
              : winner.seat === view.mySeat
                ? "You win the game!"
                : view.mySeat !== null
                  ? `${winner.username} wins the game`
                  : `${winner.username} wins`}
          </b>
          <span>
            {result.armageddon
              ? `Draw by ${result.reason}, so Black wins the Armageddon game`
              : winner === null
                ? `By ${result.reason}. Draws don't count, so the match goes on.`
                : `By ${result.reason}`}
            {winner && winner.wins + 1 >= view.winsToAdvance ? " · wins the match" : ""}
          </span>
        </div>
      )}
      {view.paused && !result && <div className="board-banner paused">⏸ Paused</div>}
      {!board && !result && !view.paused && <div className="board-banner paused">Next game starting…</div>}
    </div>
  );
}

const squareOf = (name: string) => FILES.indexOf(name[0]!) + (Number(name[1]) - 1) * 8;

function MatchScore({ view }: { view: TableView }) {
  const seats = view.seats.filter((s): s is SeatView => s !== null);
  return (
    <div className="card match-score">
      <span className="muted small">
        Match · first to {view.winsToAdvance} win{view.winsToAdvance === 1 ? "" : "s"}
      </span>
      {seats.map((s) => (
        <div key={s.seat} className="line">
          <span>{view.mySeat === s.seat ? "You" : s.username}</span>
          <b>{s.wins}</b>
        </div>
      ))}
      {view.armageddon && <span className="armageddon">Armageddon game: a draw counts as a win for Black.</span>}
    </div>
  );
}

function Controls({ view, act }: { view: TableView; act: (a: ClientAction) => void }) {
  const [confirmResign, setConfirmResign] = useState(false);
  const live = view.board.length > 0 && !view.result && !view.paused;
  useEffect(() => {
    if (!confirmResign) return;
    const t = setTimeout(() => setConfirmResign(false), 4000);
    return () => clearTimeout(t);
  }, [confirmResign]);

  if (view.mySeat === null) return <div className="spectating muted small">You're watching this match.</div>;
  const offerFromOpponent = view.drawOfferSeat !== null && view.drawOfferSeat !== view.mySeat;
  const myOffer = view.drawOfferSeat === view.mySeat;
  const myTurn = view.legal.length > 0;

  return (
    <div className="card">
      <div className="muted small" style={{ marginBottom: 8 }}>
        {!live ? (view.paused ? "Paused" : "Between games") : myTurn ? <b className="ok">Your move</b> : "Opponent's move"}
      </div>
      {offerFromOpponent && live && (
        <div className="draw-offer" style={{ marginBottom: 8 }}>
          Your opponent offers a draw{view.armageddon ? " (in Armageddon, a draw wins for Black)" : ""}.
          <span className="controls">
            <button className="btn primary" onClick={() => act({ type: "draw" })}>
              Accept
            </button>
            <button className="btn ghost" onClick={() => act({ type: "declineDraw" })}>
              Decline
            </button>
          </span>
        </div>
      )}
      <div className="controls">
        <button className="btn ghost" disabled={!live || myOffer || offerFromOpponent} onClick={() => act({ type: "draw" })}>
          {myOffer ? "Draw offered" : "Offer draw"}
        </button>
        <button
          className={`btn ${confirmResign ? "danger" : "ghost"}`}
          disabled={!live}
          onClick={() => {
            if (!confirmResign) return setConfirmResign(true);
            setConfirmResign(false);
            act({ type: "resign" });
          }}
        >
          {confirmResign ? "Click again to resign" : "Resign"}
        </button>
      </div>
    </div>
  );
}

function MoveList({ moves }: { moves: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [moves.length]);
  const pairs: [string, string | undefined][] = [];
  for (let i = 0; i < moves.length; i += 2) pairs.push([moves[i]!, moves[i + 1]]);
  return (
    <div className="card moves" ref={ref}>
      {!moves.length ? (
        <span className="muted small">No moves yet.</span>
      ) : (
        <ol>
          {pairs.map(([w, b], i) => (
            <li key={i}>
              <span className="no">{i + 1}.</span>
              <span className={`mv ${i * 2 === moves.length - 1 ? "latest" : ""}`}>{w}</span>
              <span className={`mv ${i * 2 + 1 === moves.length - 1 ? "latest" : ""}`}>{b ?? ""}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
