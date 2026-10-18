import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
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

/** Edits a prize ladder: rows of "places X to Y win prize Z", plus loading/saving templates. */
export function LadderEditor({ rules, onChange, disabled }: { rules: PrizeRule[]; onChange: (r: PrizeRule[]) => void; disabled?: boolean }) {
  const { prizes, templates, reload, toast } = useHub();
  const active = prizes.filter((p) => !p.archived);
  const update = (i: number, patch: Partial<PrizeRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const nextPlace = rules.reduce((m, r) => Math.max(m, r.placeTo), 0) + 1;

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
        return (
          <div className="ladder-row" key={i}>
            <span className="place-tag">{placeLabel(r.placeFrom, r.placeTo)}</span>
            <label className="inline">
              Place
              <input type="number" min={1} value={r.placeFrom} disabled={disabled} onChange={(e) => update(i, { placeFrom: Number(e.target.value), placeTo: Math.max(Number(e.target.value), r.placeTo) })} />
            </label>
            <label className="inline">
              to
              <input type="number" min={r.placeFrom} value={r.placeTo} disabled={disabled} onChange={(e) => update(i, { placeTo: Number(e.target.value) })} />
            </label>
            <select value={r.prizeId || ""} disabled={disabled} onChange={(e) => update(i, { prizeId: Number(e.target.value) })}>
              <option value="">Pick a prize…</option>
              {active.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.type === "code_pool" ? ` (${p.stock} codes left)` : ""}
                </option>
              ))}
            </select>
            {prize?.type === "code_pool" && prize.stock < r.placeTo - r.placeFrom + 1 && (
              <span className="warn small">Only {prize.stock} code{prize.stock === 1 ? "" : "s"} — add more or late winners wait</span>
            )}
            {!disabled && (
              <button className="link danger" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
                Remove
              </button>
            )}
          </div>
        );
      })}
      {!disabled && (
        <div className="row">
          <button className="btn ghost small-btn" onClick={() => onChange([...rules, { placeFrom: nextPlace, placeTo: nextPlace, prizeId: active[0]!.id }])}>
            + Add prize for {placeLabel(nextPlace, nextPlace)} place
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
