import { useEffect, useState } from "react";
import type { Action, SeatView, TableView } from "../shared/protocol.ts";
import { PlayingCard } from "./Cards.tsx";
import { chips, formatClock, tableKey, useGame, useServerNow } from "./game.tsx";

export function TablePage({ tournamentId, tableId }: { tournamentId: number; tableId: number }) {
  const { tables, send, tournaments, status } = useGame();
  const view = tables[tableKey(tournamentId, tableId)];
  const summary = tournaments.find((t) => t.id === tournamentId);

  // Subscribe while this page is open (own table is subscribed automatically anyway).
  useEffect(() => {
    if (status !== "open") return;
    send({ type: "watch", tournamentId, tableId });
    return () => send({ type: "watch", tournamentId, tableId: null });
  }, [tournamentId, tableId, status]);

  const myTable = summary?.me?.tableId;
  return (
    <main className="table-page">
      <div className="table-head">
        <a className="back" href={`#/t/${tournamentId}`}>
          ← {summary?.name ?? "Tournament"}
        </a>
        <span className="muted">Table {tableId}</span>
        {view && <LevelClock view={view} remaining={summary?.remaining ?? 0} />}
        {myTable != null && myTable !== tableId && (
          <a className="btn primary small-btn" href={`#/t/${tournamentId}/table/${myTable}`}>
            Back to my table
          </a>
        )}
      </div>
      {!view ? (
        <div className="center muted">
          {summary?.me?.place === 1
            ? "🏆 You won the tournament!"
            : summary?.me?.waiting
              ? `You won this table! You'll move to your round ${summary.me.waiting.round} table when the rest of your group finishes (${summary.me.waiting.groupDone}/${summary.me.waiting.groupSize} tables done).`
              : summary?.status === "finished" || summary?.status === "cancelled"
                ? "This tournament is over."
                : "This table has finished (or is loading)."}
        </div>
      ) : (
        <Table view={view} />
      )}
    </main>
  );

}

function LevelClock({ view, remaining }: { view: TableView; remaining: number }) {
  const now = useServerNow(500);
  const left = view.phaseEndsAt !== null ? view.phaseEndsAt - now : view.phaseRemainingMs;
  return (
    <span className="level-clock">
      {view.round === view.totalRounds ? "Final table" : `Round ${view.round}/${view.totalRounds}`} ·{" "}
      {view.phase === "break" ? "Break" : `Lvl ${view.levelIndex + 1}`} · {chips(view.level.smallBlind)}/{chips(view.level.bigBlind)}
      {view.level.ante > 0 && ` (${chips(view.level.ante)})`}
      {left !== null && <> · {formatClock(left)}</>}
      <span className="muted"> · {remaining} left in tournament</span>
    </span>
  );
}

/** Seat positions around the oval (percent of the felt), starting bottom-center and going clockwise. */
function seatPosition(i: number, n: number) {
  const angle = Math.PI / 2 + (i / n) * Math.PI * 2;
  return {
    seat: { left: 50 + 44 * Math.cos(angle), top: 50 + 42 * Math.sin(angle) },
    bet: { left: 50 + 27 * Math.cos(angle), top: 50 + 25 * Math.sin(angle) },
  };
}

function Table({ view }: { view: TableView }) {
  const { send } = useGame();
  const n = view.tableSize;
  // Rotate so the viewer sits at the bottom.
  const rotation = view.mySeat ?? 0;
  const me = view.mySeat !== null ? view.seats[view.mySeat] : null;

  return (
    <>
      <div className="felt-wrap">
        <div className="felt">
          <div className="felt-center">
            <div className="board">
              {view.board.map((c, i) => (
                <PlayingCard key={i} card={c} />
              ))}
            </div>
            {view.pot > 0 && <div className="pot">Pot {chips(view.pot)}</div>}
            {view.paused && <div className="table-banner">Tournament paused</div>}
            {!view.paused && view.onBreak && !view.street && <div className="table-banner">On break</div>}
            {!view.street && !view.onBreak && !view.paused && <div className="table-banner muted">Waiting for players…</div>}
          </div>

          {Array.from({ length: n }, (_, i) => {
            const seatIdx = (i + rotation) % n;
            const s = view.seats[seatIdx];
            const pos = seatPosition(i, n);
            return (
              <div key={seatIdx}>
                <div className="seat-slot" style={{ left: `${pos.seat.left}%`, top: `${pos.seat.top}%` }}>
                  {s ? <Seat s={s} view={view} isMe={seatIdx === view.mySeat} /> : <div className="seat empty-seat">Empty</div>}
                  {view.button === seatIdx && view.street && <span className="dealer">D</span>}
                </div>
                {s && s.bet > 0 && (
                  <div className="bet" style={{ left: `${pos.bet.left}%`, top: `${pos.bet.top}%` }}>
                    {chips(s.bet)}
                  </div>
                )}
              </div>
            );
          })}
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
      {view.legal ? (
        <ActionBar view={view} />
      ) : (
        me &&
        !me.away && (
          <div className="action-bar idle">
            <button className="btn ghost" onClick={() => send({ type: "sitOut", tournamentId: view.tournamentId })}>
              Sit out
            </button>
          </div>
        )
      )}
    </>
  );
}

function Seat({ s, view, isMe }: { s: SeatView; view: TableView; isMe: boolean }) {
  const acting = view.toActSeat === s.seat && !view.handComplete;
  const winner = view.handComplete && s.won > 0;
  return (
    <div className={`seat ${acting ? "acting" : ""} ${s.folded ? "folded" : ""} ${winner ? "winner" : ""} ${isMe ? "me" : ""} ${s.away ? "away" : ""}`}>
      <div className="hole">
        {s.holeCards.map((c, i) => (
          <PlayingCard key={i} card={c} small={!isMe} />
        ))}
      </div>
      <div className="plate">
        <img src={s.avatarUrl} alt="" width={30} height={30} />
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
        <div className="tag">{s.lastAction}</div>
      ) : null}
      {acting && <TurnTimer view={view} />}
    </div>
  );
}

function TurnTimer({ view }: { view: TableView }) {
  const now = useServerNow(100);
  if (view.actionStartedAt === null || view.actionDeadline === null) return null;
  if (view.paused) return <div className="timer"><div className="timer-fill" style={{ width: "100%" }} /></div>;
  const normalEnd = view.actionStartedAt + view.decisionMs;
  const inBank = now > normalEnd;
  const pct = inBank
    ? ((view.actionDeadline - now) / Math.max(1, view.actionDeadline - normalEnd)) * 100
    : ((normalEnd - now) / view.decisionMs) * 100;
  return (
    <div className={`timer ${inBank ? "bank" : ""}`} title={inBank ? "Using time bank" : undefined}>
      <div className="timer-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

function ActionBar({ view }: { view: TableView }) {
  const { send } = useGame();
  const legal = view.legal!;
  const me = view.seats[view.mySeat!]!;
  const totalPot = view.pot + view.seats.reduce((n, s) => n + (s?.bet ?? 0), 0);
  const toCall = Math.max(0, view.currentBet - me.bet);
  const clamp = (v: number) => Math.round(Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, v)));
  const [raiseTo, setRaiseTo] = useState(legal.minRaiseTo);

  // Reset the raise amount each new decision.
  useEffect(() => setRaiseTo(legal.minRaiseTo), [legal.minRaiseTo, legal.maxRaiseTo, view.handNo]);

  const act = (action: Action) =>
    send({ type: "action", tournamentId: view.tournamentId, action });

  const presets: [string, number][] = [
    ["Min", legal.minRaiseTo],
    ["½ Pot", clamp(view.currentBet + (totalPot + toCall) / 2)],
    ["Pot", clamp(view.currentBet + totalPot + toCall)],
    ["All-in", legal.maxRaiseTo],
  ];
  const isBet = view.currentBet === 0;
  const raiseLabel = raiseTo === legal.maxRaiseTo ? "All-in" : isBet ? "Bet" : "Raise to";

  return (
    <div className="action-bar">
      <div className="actions">
        <button className="btn act fold" onClick={() => act({ type: "fold" })}>
          Fold
        </button>
        {legal.canCheck ? (
          <button className="btn act call" onClick={() => act({ type: "check" })}>
            Check
          </button>
        ) : (
          <button className="btn act call" onClick={() => act({ type: "call" })}>
            {legal.callAmount >= me.chips ? "Call all-in" : "Call"} {chips(legal.callAmount)}
          </button>
        )}
        {legal.canRaise && (
          <button className="btn act raise" onClick={() => act({ type: "raise", to: clamp(raiseTo) })}>
            {raiseLabel} {chips(raiseTo)}
          </button>
        )}
      </div>
      {legal.canRaise && legal.maxRaiseTo > legal.minRaiseTo && (
        <div className="sizing">
          {presets.map(([label, v]) => (
            <button key={label} className="btn ghost preset" onClick={() => setRaiseTo(v)}>
              {label}
            </button>
          ))}
          <input
            type="range"
            min={legal.minRaiseTo}
            max={legal.maxRaiseTo}
            step={Math.max(1, Math.floor(view.level.bigBlind / 2))}
            value={raiseTo}
            onChange={(e) => setRaiseTo(clamp(Number(e.target.value)))}
          />
          <input
            type="number"
            className="amount"
            min={legal.minRaiseTo}
            max={legal.maxRaiseTo}
            value={raiseTo}
            onChange={(e) => setRaiseTo(Number(e.target.value))}
            onBlur={() => setRaiseTo(clamp(raiseTo))}
          />
        </div>
      )}
    </div>
  );
}
