import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { KIND_LABEL, PRIZE_KINDS } from "../shared/prizeKinds.ts";
import type { AwardStatus, BotStatus, GameEventStatus, GameRow, Prize, PrizeRule, Template } from "../shared/protocol.ts";
import { api, placeLabel } from "./api.ts";

// ---------------------------------------------------------------- shared data

interface Hub {
  /** False until the first load finishes, so pages don't flash "nothing here". */
  loaded: boolean;
  bot: BotStatus | null;
  prizes: Prize[];
  games: GameRow[];
  templates: Template[];
  reload: () => Promise<void>;
  toast: (message: string, kind?: "ok" | "error") => void;
}

const HubContext = createContext<Hub | null>(null);

export function useHub() {
  return useContext(HubContext)!;
}

/** Bot status, prizes, games and templates are used across pages, so they're loaded once here. */
export function HubProvider({ children }: { children: ReactNode }) {
  const [bot, setBot] = useState<BotStatus | null>(null);
  const [prizes, setPrizes] = useState<Prize[]>([]);
  const [games, setGames] = useState<GameRow[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; message: string; kind: "ok" | "error" }[]>([]);

  const reload = useCallback(async () => {
    const [b, p, g, t] = await Promise.allSettled([
      api<BotStatus>("/api/bot"),
      api<Prize[]>("/api/prizes"),
      api<GameRow[]>("/api/games"),
      api<Template[]>("/api/templates"),
    ]);
    if (b.status === "fulfilled") setBot(b.value);
    if (p.status === "fulfilled") setPrizes(p.value);
    if (g.status === "fulfilled") setGames(g.value);
    if (t.status === "fulfilled") setTemplates(t.value);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 20_000);
    return () => clearInterval(t);
  }, [reload]);

  const toast = useCallback((message: string, kind: "ok" | "error" = "ok") => {
    const id = Math.random();
    setToasts((ts) => [...ts, { id, message, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);

  return (
    <HubContext.Provider value={{ loaded, bot, prizes, games, templates, reload, toast }}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </HubContext.Provider>
  );
}

/** Wraps an async action: disables the button while it runs and shows errors as a toast. */
export function useAction() {
  const { toast } = useHub();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn: () => Promise<unknown>, success?: string) => {
      setBusy(true);
      try {
        await fn();
        if (success) toast(success);
        return true;
      } catch (err) {
        toast((err as Error).message, "error");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { busy, run };
}

// ---------------------------------------------------------------- small pieces

export function PageHeader({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      {children && <div className="row">{children}</div>}
    </header>
  );
}

const EVENT_STATUS: Record<GameEventStatus, string> = {
  registering: "Upcoming",
  running: "Live",
  finished: "Finished",
  cancelled: "Cancelled",
};

export function EventStatus({ status }: { status: GameEventStatus }) {
  return <span className={`pill ev-${status}`}>{EVENT_STATUS[status]}</span>;
}

const AWARD_STATUS: Record<AwardStatus, string> = {
  pending: "Sending",
  waiting_stock: "Waiting for codes",
  sent: "Sent",
  dm_failed: "DM failed",
  cancelled: "Cancelled",
  manual: "Delivered by hand",
};

export function AwardStatusPill({ status }: { status: AwardStatus }) {
  return <span className={`pill aw-${status}`}>{AWARD_STATUS[status]}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty muted">{children}</div>;
}

/** Picks a channel from the bot's server, or takes a pasted ID when the bot is offline. */
export function ChannelPicker({ value, onChange, placeholder = "Default channel" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const { bot } = useHub();
  const channels = bot?.channels ?? [];
  const [typed, setTyped] = useState(value);
  useEffect(() => setTyped(value), [value]);
  // Typed IDs are committed on blur, so a half-typed ID is never saved.
  if (channels.length === 0)
    return (
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value.trim())}
        onBlur={() => typed !== value && onChange(typed)}
        placeholder="Channel ID (bot offline)"
        inputMode="numeric"
      />
    );
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {channels.map((c) => (
        <option key={c.id} value={c.id}>
          #{c.name}
        </option>
      ))}
      {value && !channels.some((c) => c.id === value) && <option value={value}>Channel {value}</option>}
    </select>
  );
}

/** The lowest place no row covers yet: 1st, then 2nd… and it fills gaps left by a removed row. */
const firstFreePlace = (rules: PrizeRule[]) =>
  [...rules].sort((a, b) => a.placeFrom - b.placeFrom).reduce((n, r) => (r.placeFrom <= n ? Math.max(n, r.placeTo + 1) : n), 1);

/** A prize dropdown grouped into Lucid accounts, Lupees and other prizes, biggest first. */
function PrizeSelect({ value, prizes, disabled, onChange }: { value: number; prizes: Prize[]; disabled?: boolean; onChange: (id: number) => void }) {
  return (
    <select value={value || ""} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
      <option value="">Pick a prize…</option>
      {PRIZE_KINDS.map((kind) => {
        const group = prizes.filter((p) => p.kind === kind);
        if (group.length === 0) return null;
        return (
          <optgroup key={kind} label={KIND_LABEL[kind]}>
            {group.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.type === "code_pool" ? ` (${p.stock} code${p.stock === 1 ? "" : "s"} left)` : ""}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

/**
 * Edits a prize ladder: one row per place with the prize it wins, picked from a dropdown. A row can cover a
 * range of places (4th–10th), and a place can have several rows to win several prizes. Plus saved ladders.
 */
export function LadderEditor({ rules, onChange, disabled }: { rules: PrizeRule[]; onChange: (r: PrizeRule[]) => void; disabled?: boolean }) {
  const { prizes, templates, reload, toast } = useHub();
  /** The row whose place boxes are open. Ranges always show theirs; a single place shows them after clicking its tag. */
  const [placesOpen, setPlacesOpen] = useState<number | null>(null);
  const active = prizes.filter((p) => !p.archived);
  const update = (i: number, patch: Partial<PrizeRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const nextPlace = firstFreePlace(rules);
  /** Inserts a row and keeps rows in place order. The sort is stable, so "also give" rows stay under their place. */
  const add = (rule: PrizeRule, at = rules.length) => {
    setPlacesOpen(null);
    onChange([...rules.slice(0, at), rule, ...rules.slice(at)].sort((a, b) => a.placeFrom - b.placeFrom));
  };
  const remove = (i: number) => {
    setPlacesOpen(null);
    onChange(rules.filter((_, j) => j !== i));
  };
  /** Closing a row's place boxes fixes a range typed backwards ("to" before "from"). */
  const closePlaces = (i: number) => {
    setPlacesOpen(null);
    const r = rules[i];
    if (r && !(r.placeTo >= r.placeFrom)) update(i, { placeTo: r.placeFrom });
  };

  const saveAsTemplate = async () => {
    const name = prompt("Name this prize ladder so you can reuse it (e.g. Weekly poker):");
    if (!name) return;
    try {
      await api("/api/templates", { body: { name, rules } });
      await reload();
      toast(`Saved "${name}"`);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  if (active.length === 0)
    return (
      <Empty>
        No prizes yet. <a href="#/prizes">Create a prize</a> first, then come back to attach it.
      </Empty>
    );

  return (
    <div className="ladder">
      {rules.length === 0 && <p className="muted small">No prizes attached — winners won't get anything from this event.</p>}
      {rules.map((r, i) => {
        const prize = prizes.find((p) => p.id === r.prizeId);
        const showPlaces = r.placeTo !== r.placeFrom || placesOpen === i;
        return (
          <div className="ladder-row" key={i}>
            {disabled ? (
              <span className="place-tag">{placeLabel(r.placeFrom, r.placeTo)}</span>
            ) : (
              <button className="place-tag" title="Change the place" onClick={() => setPlacesOpen(i)}>
                {placeLabel(r.placeFrom, r.placeTo)}
              </button>
            )}
            {showPlaces && !disabled && (
              <span className="row" onFocus={() => setPlacesOpen(i)} onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && closePlaces(i)}>
                <label className="inline">
                  Place
                  <input
                    type="number"
                    min={1}
                    value={r.placeFrom}
                    autoFocus={r.placeTo === r.placeFrom}
                    onChange={(e) => update(i, { placeFrom: Number(e.target.value), placeTo: Math.max(Number(e.target.value), r.placeTo) })}
                  />
                </label>
                <label className="inline">
                  to
                  <input type="number" min={r.placeFrom} value={r.placeTo} onChange={(e) => update(i, { placeTo: Number(e.target.value) })} />
                </label>
              </span>
            )}
            <PrizeSelect value={r.prizeId} prizes={active} disabled={disabled} onChange={(prizeId) => update(i, { prizeId })} />
            {prize?.type === "code_pool" && prize.stock < r.placeTo - r.placeFrom + 1 && (
              <span className="warn small">Only {prize.stock} code{prize.stock === 1 ? "" : "s"} — add more or late winners wait</span>
            )}
            {!disabled && (
              <>
                <button className="link" title={`Give ${placeLabel(r.placeFrom, r.placeTo)} place another prize as well`} onClick={() => add({ placeFrom: r.placeFrom, placeTo: r.placeTo, prizeId: 0 }, i + 1)}>
                  + also give
                </button>
                <button className="link danger" onClick={() => remove(i)}>
                  Remove
                </button>
              </>
            )}
          </div>
        );
      })}
      {!disabled && (
        <div className="row">
          <button className="btn ghost small-btn" onClick={() => add({ placeFrom: nextPlace, placeTo: nextPlace, prizeId: 0 })}>
            + Add {placeLabel(nextPlace, nextPlace)} place
          </button>
          <button className="link" onClick={() => add({ placeFrom: nextPlace, placeTo: nextPlace + 4, prizeId: 0 })}>
            + Add a range ({placeLabel(nextPlace, nextPlace + 4)})
          </button>
          {templates.length > 0 && (
            <select value="" onChange={(e) => onChange(templates.find((t) => t.id === Number(e.target.value))?.rules ?? rules)}>
              <option value="">Load a saved ladder…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
          {rules.length > 0 && (
            <button className="link" onClick={saveAsTemplate}>
              Save as reusable ladder
            </button>
          )}
        </div>
      )}
    </div>
  );
}
