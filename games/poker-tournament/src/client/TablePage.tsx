import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { Action, SeatView, TableView } from "../shared/protocol.ts";
import type { Equity } from "../shared/equity.ts";
import { describeHand } from "../shared/handName.ts";
import { PlayingCard } from "./Cards.tsx";
import { TableChat } from "./Chat.tsx";
import { chips, formatClock, tableKey, useGame, useServerNow } from "./game.tsx";
import { useEquity } from "./useEquity.ts";

export function TablePage({ tournamentId, tableId }: { tournamentId: number; tableId: number }) {
  const { tables, chats, send, tournaments, status } = useGame();
  const view = tables[tableKey(tournamentId, tableId)];
  const summary = tournaments.find((t) => t.id === tournamentId);
  const [sound, setSound] = usePref("poker:sound", true);
  // On narrow screens the chat covers the table, so it starts closed there.
  const [chatOpen, setChatOpen] = usePref("poker:chat", typeof innerWidth === "number" && innerWidth >= 1100);
  const messages = chats[tableKey(tournamentId, tableId)] ?? [];
  const unread = useUnread(messages.length, chatOpen);

  // Subscribe while this page is open (own table is subscribed automatically anyway).
  useEffect(() => {
    if (status !== "open") return;
    send({ type: "watch", tournamentId, tableId });
    return () => send({ type: "watch", tournamentId, tableId: null });
  }, [tournamentId, tableId, status]);

  const myTable = summary?.me?.tableId;
  return (
    <main className={`table-page ${chatOpen ? "chat-open" : ""}`}>
      <div className="room" aria-hidden="true">
        {FLOATING_SUITS.map((s, i) => (
          <span key={i} className={`float-suit ${s === "♥" || s === "♦" ? "red" : ""}`} style={{ left: `${(i * 137) % 100}%`, animationDelay: `${-i * 3.7}s`, animationDuration: `${26 + (i % 5) * 6}s` }}>
            {s}
          </span>
        ))}
      </div>
      <div className="table-main">
        <div className="table-head">
          <a className="back" href={`#/t/${tournamentId}`}>
            ← {summary?.name ?? "Tournament"}
          </a>
          <span className="table-name">Table {tableId}</span>
          {view && <LevelClock view={view} remaining={summary?.remaining ?? 0} />}
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
        {!view ? (
          <div className="center muted table-empty">
            {summary?.me?.place === 1
              ? "🏆 You won the tournament!"
              : summary?.me?.waiting
                ? `You won this table! You'll move to your round ${summary.me.waiting.round} table when the rest of your group finishes (${summary.me.waiting.groupDone}/${summary.me.waiting.groupSize} tables done).`
                : summary?.status === "finished" || summary?.status === "cancelled"
                  ? "This tournament is over."
                  : "This table has finished (or is loading)."}
          </div>
        ) : (
          <Table view={view} sound={sound} />
        )}
      </div>
      {chatOpen && (
        <aside className="chat-panel">
          <TableChat tournamentId={tournamentId} tableId={tableId} messages={messages} canSend={Boolean(view)} onClose={() => setChatOpen(false)} />
        </aside>
      )}
    </main>
  );
}

const FLOATING_SUITS = ["♠", "♥", "♣", "♦", "♠", "♦", "♣", "♥", "♠", "♣"];

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

function LevelClock({ view, remaining }: { view: TableView; remaining: number }) {
  const now = useServerNow(500);
  const left = view.phaseEndsAt !== null ? view.phaseEndsAt - now : view.phaseRemainingMs;
  return (
    <span className="level-clock">
      <span className="lc-pill">{view.round === view.totalRounds ? "Final table" : `Round ${view.round}/${view.totalRounds}`}</span>
      <span className="lc-pill">
        {view.phase === "break" ? "Break" : `Level ${view.levelIndex + 1}`} · <b>{chips(view.level.smallBlind)}/{chips(view.level.bigBlind)}</b>
        {view.level.ante > 0 && ` · ante ${chips(view.level.ante)}`}
        {left !== null && <> · {formatClock(left)}</>}
      </span>
      {view.nextLevel && view.phase !== "break" && (
        <span className="lc-pill muted">
          Next {chips(view.nextLevel.smallBlind)}/{chips(view.nextLevel.bigBlind)}
        </span>
      )}
      <span className="lc-pill muted">{remaining} left</span>
    </span>
  );
}

/** Seat positions around the oval (percent of the felt), starting bottom-center and going clockwise. */
function seatPosition(i: number, n: number) {
  const angle = Math.PI / 2 + (i / n) * Math.PI * 2;
  return {
    // Seats sit out on the rail; bets in front of them, clear of the board.
    seat: { left: 50 + 49 * Math.cos(angle), top: 50 + 44 * Math.sin(angle) },
    bet: { left: 50 + 33 * Math.cos(angle), top: 50 + 24 * Math.sin(angle) },
  };
}

/** A short chime when it becomes your turn. */
function useTurnSound(myTurn: boolean, enabled: boolean, handNo: number) {
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
  }, [myTurn, enabled, handNo]);
}

function Table({ view, sound }: { view: TableView; sound: boolean }) {
  const { send } = useGame();
  const n = view.tableSize;
  // Rotate so the viewer sits at the bottom.
  const rotation = view.mySeat ?? 0;
  const me = view.mySeat !== null ? view.seats[view.mySeat] : null;
  const myTurn = Boolean(view.legal);
  useTurnSound(myTurn, sound, view.handNo);
  const totalPot = view.pot + view.seats.reduce((t, s) => t + (s?.bet ?? 0), 0);
  const myHand = me && !me.folded ? describeHand(me.holeCards, view.board) : null;
  // Win chance while the hand is live: against everyone still in, holding random cards.
  const live = Boolean(me && me.inHand && !me.folded && view.street && !view.handComplete);
  const opponents = view.seats.filter((s) => s && s.userId !== me?.userId && s.inHand && !s.folded).length;
  const equity = useEquity(live ? me!.holeCards : null, view.board, opponents);

  return (
    <>
      <div className="felt-wrap">
        <div className="rail">
          <div className="felt">
            <div className="felt-center">
              <div className="board">
                {Array.from({ length: 5 }, (_, i) =>
                  view.board[i] ? <PlayingCard key={`${view.handNo}-${view.board[i]}`} card={view.board[i]!} size="board" /> : <span key={i} className="card-slot" />,
                )}
              </div>
              {totalPot > 0 && (
                <div className="pot">
                  <ChipStack amount={totalPot} />
                  <span>Pot {chips(totalPot)}</span>
                </div>
              )}
              {view.paused && <div className="table-banner">Tournament paused</div>}
              {!view.paused && view.onBreak && !view.street && <div className="table-banner">On break ☕</div>}
              {!view.street && !view.onBreak && !view.paused && <div className="table-banner muted">Waiting for players…</div>}
              {view.street && !view.paused && <div className="hand-no">Hand #{view.handNo}</div>}
            </div>

            {Array.from({ length: n }, (_, i) => {
              const seatIdx = (i + rotation) % n;
              const s = view.seats[seatIdx];
              const pos = seatPosition(i, n);
              return (
                <div key={seatIdx}>
                  <div className="seat-slot" style={{ left: `${pos.seat.left}%`, top: `${pos.seat.top}%` }}>
                    {s ? (
                      <Seat
                        s={s}
                        view={view}
                        isMe={seatIdx === view.mySeat}
                        handLabel={seatIdx === view.mySeat ? myHand : null}
                        equity={seatIdx === view.mySeat ? equity : null}
                        opponents={opponents}
                      />
                    ) : (
                      <div className="seat empty-seat">Open seat</div>
                    )}
                    {view.button === seatIdx && view.street && <span className="dealer-btn">D</span>}
                  </div>
                  {s && s.bet > 0 && (
                    <div className="bet" style={{ left: `${pos.bet.left}%`, top: `${pos.bet.top}%` }}>
                      <ChipStack amount={s.bet} />
                      <span>{chips(s.bet)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {me?.away && (
        <div className="away-bar">
          You're sitting out — you're folded automatically each hand and blinds are still posted.
          <button className="btn primary" onClick={() => send({ type: "back", tournamentId: view.tournamentId })}>
            I'm back
          </button>
        </div>
      )}
      {me && !me.away && <ActionArea view={view} me={me} />}
    </>
  );
}

/** A little stack of chips whose height grows with the amount. */
function ChipStack({ amount }: { amount: number }) {
  const count = Math.max(1, Math.min(6, Math.ceil(Math.log10(Math.max(10, amount)) - 0.5)));
  const colors = ["#c8202a", "#1f6fd1", "#1f9d5a", "#222", "#7b3fbf", "#e3b341"];
  return (
    <span className="chip-stack" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="chip" style={{ bottom: i * 3, background: colors[(i + count) % colors.length] }} />
      ))}
    </span>
  );
}

function Seat(p: { s: SeatView; view: TableView; isMe: boolean; handLabel: string | null; equity: Equity | null; opponents: number }) {
  const { s, view, isMe, handLabel, equity } = p;
  const acting = view.toActSeat === s.seat && !view.handComplete;
  const winner = view.handComplete && s.won > 0;
  return (
    <div className={`seat ${acting ? "acting" : ""} ${s.folded ? "folded" : ""} ${winner ? "winner" : ""} ${isMe ? "me" : ""} ${s.away ? "away" : ""}`}>
      <div className="hole">
        {s.holeCards.map((c, i) => (
          <PlayingCard key={`${view.handNo}-${i}-${c}`} card={c} size={isMe ? "mine" : "small"} />
        ))}
      </div>
      <div className="plate">
        <span className="avatar">
          <img src={s.avatarUrl} alt="" width={44} height={44} />
          {acting && <TurnRing view={view} />}
        </span>
        <div className="plate-text">
          <div className="name">
            {!s.connected && <span title="Disconnected">⚠ </span>}
            {s.username}
          </div>
          <div className="stack">{s.allIn && s.chips === 0 ? "All-in" : chips(s.chips)}</div>
        </div>
      </div>
      {winner ? (
        <div className="tag win">
          +{chips(s.won)}
          {s.handName && ` · ${s.handName}`}
        </div>
      ) : s.away ? (
        <div className="tag">Sitting out</div>
      ) : s.lastAction ? (
        <div className={`tag act-${s.lastAction.split(" ")[0]!.toLowerCase().replace("-", "")}`}>{s.lastAction}</div>
      ) : null}
      {isMe && !winner && (handLabel || equity) && <MyRead label={handLabel} equity={equity} opponents={p.opponents} />}
    </div>
  );
}

/**
 * Under your seat: what you hold ("Pocket Kings") and your chance to win, as a number and a bar.
 * The chance is against the opponents still in, holding random cards (their real cards are unknown).
 */
function MyRead({ label, equity, opponents }: { label: string | null; equity: Equity | null; opponents: number }) {
  const win = equity ? Math.round(equity.win * 100) : null;
  const tie = equity ? Math.round(equity.tie * 100) : 0;
  const level = win === null ? "" : win >= 50 ? "good" : win >= 25 ? "ok" : "low";
  return (
    <div
      className={`my-read ${level}`}
      title={
        equity
          ? `Estimated from ${equity.iterations.toLocaleString()} random deals against ${opponents} opponent${opponents === 1 ? "" : "s"} holding random cards. Their real cards are unknown.`
          : undefined
      }
    >
      <div className="mr-line">
        {label && <span className="mr-hand">{label}</span>}
        {win !== null && (
          <span className="mr-win">
            <b>{win}%</b> win{tie >= 1 && <span className="muted"> · {tie}% split</span>}
          </span>
        )}
      </div>
      {equity && (
        <div className="wc-bar">
          <span className="wc-win" style={{ width: `${equity.win * 100}%` }} />
          <span className="wc-tie" style={{ width: `${equity.tie * 100}%` }} />
        </div>
      )}
    </div>
  );
}

/** A ring around the acting player's avatar that drains as their time runs out (red in the time bank). */
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

type PreAction = "checkFold" | "check" | "callAny" | null;

/** Your controls: the big action buttons on your turn, otherwise pre-actions and sit out. */
function ActionArea({ view, me }: { view: TableView; me: SeatView }) {
  const { send } = useGame();
  const [pre, setPre] = useState<PreAction>(null);
  const fired = useRef("");
  const decisionKey = `${view.handNo}:${view.street}:${view.currentBet}`;

  // Pre-actions only last for the street they were picked on.
  useEffect(() => setPre(null), [view.handNo, view.street]);

  // When it becomes our turn, play the pre-action once.
  useEffect(() => {
    const legal = view.legal;
    if (!legal || !pre || fired.current === decisionKey) return;
    let action: Action | null = null;
    if (pre === "checkFold") action = legal.canCheck ? { type: "check" } : { type: "fold" };
    else if (pre === "check") action = legal.canCheck ? { type: "check" } : null;
    else if (pre === "callAny") action = legal.canCheck ? { type: "check" } : { type: "call" };
    setPre(null);
    if (!action) return;
    fired.current = decisionKey;
    send({ type: "action", tournamentId: view.tournamentId, action });
  }, [view.legal, pre, decisionKey]);

  if (view.legal && !pre) return <ActionBar view={view} me={me} />;

  const inHand = me.inHand && !me.folded && !me.allIn && view.street && !view.handComplete;
  const toggle = (p: PreAction) => setPre(pre === p ? null : p);
  const facingBet = view.currentBet > me.bet;
  return (
    <div className="action-bar idle">
      {inHand ? (
        <div className="pre-actions">
          <span className="muted small">When it's your turn:</span>
          <button className={`pre ${pre === "checkFold" ? "on" : ""}`} onClick={() => toggle("checkFold")}>
            {facingBet ? "Fold" : "Check / Fold"}
          </button>
          {!facingBet && (
            <button className={`pre ${pre === "check" ? "on" : ""}`} onClick={() => toggle("check")}>
              Check
            </button>
          )}
          <button className={`pre ${pre === "callAny" ? "on" : ""}`} onClick={() => toggle("callAny")}>
            {facingBet ? `Call ${chips(Math.min(view.currentBet - me.bet, me.chips))}` : "Call any"}
          </button>
        </div>
      ) : (
        <span className="muted small">{me.folded ? "You folded — next hand soon." : view.handComplete ? "Next hand coming up…" : ""}</span>
      )}
      <button className="btn ghost sit-out" onClick={() => send({ type: "sitOut", tournamentId: view.tournamentId })}>
        Sit out
      </button>
    </div>
  );
}

function ActionBar({ view, me }: { view: TableView; me: SeatView }) {
  const { send } = useGame();
  const legal = view.legal!;
  const totalPot = view.pot + view.seats.reduce((n, s) => n + (s?.bet ?? 0), 0);
  const toCall = Math.max(0, view.currentBet - me.bet);
  const step = Math.max(1, Math.floor(view.level.bigBlind / 2));
  // Round to the slider's step (from the minimum), but always allow exactly the minimum and all-in.
  const clamp = (v: number) =>
    Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, legal.minRaiseTo + Math.round((v - legal.minRaiseTo) / step) * step));
  const [raiseTo, setRaiseTo] = useState(legal.minRaiseTo);

  // Reset the raise amount each new decision.
  useEffect(() => setRaiseTo(legal.minRaiseTo), [legal.minRaiseTo, legal.maxRaiseTo, view.handNo]);

  const act = (action: Action) => send({ type: "action", tournamentId: view.tournamentId, action });
  const canSize = legal.canRaise && legal.maxRaiseTo > legal.minRaiseTo;
  const isBet = view.currentBet === 0;
  const raiseLabel = raiseTo === legal.maxRaiseTo ? "All-in" : isBet ? "Bet" : "Raise to";
  const call = () => act(legal.canCheck ? { type: "check" } : { type: "call" });
  const raise = () => act({ type: "raise", to: clamp(raiseTo) });

  // Keyboard: F fold, C check/call, R bet/raise, ↑/↓ size the bet. Not while typing in chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && !(el as HTMLInputElement).classList.contains("bet-range")) return;
      const k = e.key.toLowerCase();
      if (k === "f") act({ type: "fold" });
      else if (k === "c") call();
      else if (k === "r" && legal.canRaise) raise();
      else if ((k === "arrowup" || k === "arrowright") && canSize) setRaiseTo((v) => clamp(v + step));
      else if ((k === "arrowdown" || k === "arrowleft") && canSize) setRaiseTo((v) => clamp(v - step));
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  const presets: [string, number][] = [
    ["Min", legal.minRaiseTo],
    ["½ Pot", clamp(view.currentBet + (totalPot + toCall) / 2)],
    ["¾ Pot", clamp(view.currentBet + ((totalPot + toCall) * 3) / 4)],
    ["Pot", clamp(view.currentBet + totalPot + toCall)],
    ["All-in", legal.maxRaiseTo],
  ];

  return (
    <div className="action-bar my-turn">
      {canSize && (
        <BetSlider
          value={raiseTo}
          min={legal.minRaiseTo}
          max={legal.maxRaiseTo}
          step={step}
          presets={presets}
          onChange={(v) => setRaiseTo(clamp(v))}
          label={isBet ? "Bet" : "Raise to"}
        />
      )}
      <div className="actions">
        <button className="btn act fold" onClick={() => act({ type: "fold" })}>
          Fold <kbd>F</kbd>
        </button>
        <button className="btn act call" onClick={call}>
          {legal.canCheck ? "Check" : `${legal.callAmount >= me.chips ? "Call all-in" : "Call"} ${chips(legal.callAmount)}`} <kbd>C</kbd>
        </button>
        {legal.canRaise && (
          <button className="btn act raise" onClick={raise}>
            {raiseLabel} {chips(clamp(raiseTo))} <kbd>R</kbd>
          </button>
        )}
      </div>
    </div>
  );
}

/** Chip-style slider with pot-size presets and fine +/- steps. */
function BetSlider(p: {
  value: number;
  min: number;
  max: number;
  step: number;
  presets: [string, number][];
  onChange: (v: number) => void;
  label: string;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const pct = ((p.value - p.min) / Math.max(1, p.max - p.min)) * 100;
  return (
    <div className="bet-slider">
      <div className="presets">
        {p.presets.map(([label, v]) => (
          <button key={label} className={`preset ${p.value === v ? "on" : ""}`} onClick={() => p.onChange(v)}>
            {label}
          </button>
        ))}
      </div>
      <div className="slider-row">
        <button className="step" onClick={() => p.onChange(p.value - p.step)} aria-label="Less">
          −
        </button>
        <div className="range-wrap" style={{ "--pct": `${pct}%` } as CSSProperties}>
          <input
            className="bet-range"
            type="range"
            min={p.min}
            max={p.max}
            step={p.step}
            value={p.value}
            onChange={(e) => p.onChange(Number(e.target.value))}
            aria-label={`${p.label} amount`}
          />
          <div className="range-labels">
            <span>{chips(p.min)}</span>
            <span>{chips(p.max)}</span>
          </div>
        </div>
        <button className="step" onClick={() => p.onChange(p.value + p.step)} aria-label="More">
          +
        </button>
        <label className="amount-box">
          <span>{p.label}</span>
          <input
            inputMode="numeric"
            value={typed ?? chips(p.value)}
            onFocus={(e) => {
              setTyped(String(p.value));
              e.currentTarget.select();
            }}
            onChange={(e) => setTyped(e.target.value.replace(/[^0-9]/g, ""))}
            onBlur={() => {
              if (typed) p.onChange(Number(typed));
              setTyped(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </label>
      </div>
    </div>
  );
}
