import { useEffect, useMemo, useState } from "react";
import type { BlindLevel, BlindPreset, GameField } from "../shared/protocol.ts";
import { api } from "./api.ts";
import { useAction, useHub } from "./ui.tsx";

const fmt = (n: number) => n.toLocaleString();

function fmtDuration(min: number) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

/** Rounds to a "poker-friendly" number: 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × a power of ten. */
function niceRound(v: number) {
  if (v <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  return Math.round(steps.reduce((best, s) => (Math.abs(s * p - v) < Math.abs(best * p - v) ? s : best), 1) * p);
}

/** The level after `prev`: blinds up about 50%, antes kept at 10% of the big blind once they've started. */
export function nextLevel(prev: BlindLevel | undefined): BlindLevel {
  if (!prev) return { smallBlind: 25, bigBlind: 50, ante: 0, minutes: 10 };
  const bigBlind = Math.max(prev.bigBlind + 1, niceRound(prev.bigBlind * 1.5));
  return { smallBlind: Math.round(bigBlind / 2), bigBlind, ante: prev.ante > 0 ? Math.round(bigBlind / 10) : 0, minutes: prev.minutes };
}

/** Same checks the game makes, so problems show up while you type. Returns an error per level. */
export function levelProblems(levels: BlindLevel[]): (string | null)[] {
  return levels.map((l, i) => {
    const vals = [l.smallBlind, l.bigBlind, l.ante, l.minutes];
    if (vals.some((v) => !Number.isFinite(v))) return "Fill in every number";
    if (l.smallBlind < 1) return "Small blind must be at least 1";
    if (l.bigBlind < l.smallBlind) return "Big blind must be at least the small blind";
    if (l.ante < 0 || l.ante > l.bigBlind) return "Ante must be between 0 and the big blind";
    if (l.minutes < 1 || l.minutes > 120) return "Levels last 1–120 minutes";
    const prev = levels[i - 1];
    if (prev && (l.bigBlind < prev.bigBlind || l.smallBlind < prev.smallBlind)) return "Blinds can't go down";
    return null;
  });
}

const sameLevels = (a: BlindLevel[], b: BlindLevel[]) =>
  a.length === b.length && a.every((l, i) => l.smallBlind === b[i]!.smallBlind && l.bigBlind === b[i]!.bigBlind && l.ante === b[i]!.ante && l.minutes === b[i]!.minutes);

/**
 * Pick or build a blind structure: presets (the game's and your saved ones), how often blinds go up,
 * and every level editable. `extra` are other form values a preset can set (stack, breaks).
 */
export function BlindEditor(p: {
  gameId: number;
  field: GameField;
  levels: BlindLevel[];
  onChange: (levels: BlindLevel[]) => void;
  /** Values of the rest of the form (for the summary, and for saving a preset with them). */
  values: Record<string, string>;
  onSetValues: (set: Record<string, number>) => void;
}) {
  const { toast } = useHub();
  const { run } = useAction();
  const [saved, setSaved] = useState<BlindPreset[]>([]);
  const [showLevels, setShowLevels] = useState(false);
  const presets = [...(p.field.presets ?? []), ...saved];
  const problems = levelProblems(p.levels);
  const firstProblem = problems.findIndex(Boolean);

  const loadSaved = () => api<BlindPreset[]>(`/api/games/${p.gameId}/blind-presets`).then(setSaved).catch(() => setSaved([]));
  useEffect(() => void loadSaved(), [p.gameId]);

  const apply = (preset: BlindPreset) => {
    p.onChange(preset.levels.map((l) => ({ ...l })));
    if (preset.set) p.onSetValues(preset.set);
  };
  const active = presets.find((x) => sameLevels(x.levels, p.levels) && Object.entries(x.set ?? {}).every(([k, v]) => p.values[k] === undefined || Number(p.values[k]) === v));

  // "Blinds go up every N minutes": the same length for every level, or blank when they differ.
  const minutesAll = p.levels.every((l) => l.minutes === p.levels[0]?.minutes) ? p.levels[0]?.minutes : null;
  const setAllMinutes = (m: number) => p.onChange(p.levels.map((l) => ({ ...l, minutes: m })));
  const anteFrom = p.levels.findIndex((l) => l.ante > 0);
  const setAnteFrom = (lvl: number) => p.onChange(p.levels.map((l, i) => ({ ...l, ante: lvl > 0 && i + 1 >= lvl ? Math.round(l.bigBlind / 10) : 0 })));

  const update = (i: number, patch: Partial<BlindLevel>) => p.onChange(p.levels.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const stack = Number(p.values.startingStack) || 0;

  const saveAs = () => {
    const name = prompt("Name this blind structure so you can reuse it:", active?.saved ? active.name : "");
    if (!name) return;
    const set: Record<string, number> = {};
    for (const k of ["startingStack", "breakEveryLevels", "breakMinutes"]) if (p.values[k] !== undefined && p.values[k] !== "") set[k] = Number(p.values[k]);
    void run(async () => {
      await api(`/api/games/${p.gameId}/blind-presets`, { body: { name, levels: p.levels, set } });
      await loadSaved();
      toast(`Saved "${name}"`);
    });
  };

  return (
    <div className="blinds">
      <div className="preset-grid">
        {presets.map((x) => (
          <button key={x.id} type="button" className={`preset-card ${active?.id === x.id ? "on" : ""}`} onClick={() => apply(x)}>
            <span className="pc-head">
              <strong>{x.name}</strong>
              {x.saved && <span className="pill">Yours</span>}
            </span>
            <span className="pc-desc">{x.description ?? describe(x)}</span>
            <span className="pc-meta">
              {x.levels[0]!.minutes === x.levels.at(-1)!.minutes ? `${x.levels[0]!.minutes}-min levels` : "Mixed level lengths"} · {x.levels.length} levels
              {x.set?.startingStack ? ` · ${fmt(x.set.startingStack)} chips` : ""}
            </span>
            {x.saved && (
              <span
                className="pc-delete"
                role="button"
                title="Delete this preset"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!confirm(`Delete the "${x.name}" preset?`)) return;
                  void run(async () => {
                    await api(`/api/blind-presets/${x.id.replace("saved-", "")}`, { method: "DELETE" });
                    await loadSaved();
                  });
                }}
              >
                ✕
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="blind-quick">
        <label>
          <span>Blinds go up every</span>
          <span className="with-unit">
            <input
              type="number"
              min={1}
              max={120}
              value={minutesAll ?? ""}
              placeholder="mixed"
              onChange={(e) => e.target.value && setAllMinutes(Math.max(1, Math.min(120, Number(e.target.value))))}
            />
            minutes
          </span>
        </label>
        <label>
          <span>Antes start at level</span>
          <select value={anteFrom >= 0 ? anteFrom + 1 : 0} onChange={(e) => setAnteFrom(Number(e.target.value))}>
            <option value={0}>No antes</option>
            {p.levels.slice(0, 12).map((_, i) => (
              <option key={i} value={i + 1}>
                Level {i + 1}
              </option>
            ))}
          </select>
        </label>
        <BlindSummary levels={p.levels} stack={stack} breakEvery={Number(p.values.breakEveryLevels) || 0} breakMinutes={Number(p.values.breakMinutes) || 0} />
      </div>

      <BlindChart levels={p.levels} />

      <div className="row">
        <button type="button" className="btn ghost small-btn" onClick={() => setShowLevels(!showLevels)}>
          {showLevels ? "Hide levels" : `Edit levels one by one (${p.levels.length})`}
        </button>
        <button type="button" className="link" onClick={saveAs}>
          Save as my preset
        </button>
        {firstProblem >= 0 && (
          <span className="bad small">
            Level {firstProblem + 1}: {problems[firstProblem]}
          </span>
        )}
      </div>

      {showLevels && (
        <div className="level-table">
          <div className="lt-head">
            <span>Level</span>
            <span>Small blind</span>
            <span>Big blind</span>
            <span>Ante</span>
            <span>Minutes</span>
            <span />
          </div>
          {p.levels.map((l, i) => (
            <div key={i} className={`lt-row ${problems[i] ? "bad-row" : ""}`} title={problems[i] ?? undefined}>
              <span className="lt-n">{i + 1}</span>
              {(["smallBlind", "bigBlind", "ante", "minutes"] as const).map((k) => (
                <input
                  key={k}
                  type="number"
                  min={k === "ante" ? 0 : 1}
                  value={Number.isFinite(l[k]) ? l[k] : ""}
                  onChange={(e) => update(i, { [k]: e.target.value === "" ? NaN : Math.round(Number(e.target.value)) })}
                />
              ))}
              <button
                type="button"
                className="link danger lt-remove"
                title={`Remove level ${i + 1}`}
                aria-label={`Remove level ${i + 1}`}
                onClick={() => p.onChange(p.levels.filter((_, j) => j !== i))}
                disabled={p.levels.length <= 1}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="row">
            <button type="button" className="btn ghost small-btn" onClick={() => p.onChange([...p.levels, nextLevel(p.levels.at(-1))])} disabled={p.levels.length >= 60}>
              + Add level
            </button>
            <span className="muted small">New levels go up about 50% from the one before; edit any number.</span>
          </div>
        </div>
      )}
    </div>
  );
}

function describe(x: BlindPreset) {
  const l = x.levels;
  return `Starts ${fmt(l[0]!.smallBlind)}/${fmt(l[0]!.bigBlind)}, ends ${fmt(l.at(-1)!.smallBlind)}/${fmt(l.at(-1)!.bigBlind)}.`;
}

/** "Big blind is 20% of a starting stack after 1h 40m (level 11)" — how fast it gets serious. */
function BlindSummary({ levels, stack, breakEvery, breakMinutes }: { levels: BlindLevel[]; stack: number; breakEvery: number; breakMinutes: number }) {
  const facts = useMemo(() => {
    let t = 0;
    let serious: { level: number; at: number } | null = null;
    levels.forEach((l, i) => {
      if (!serious && stack > 0 && l.bigBlind * 5 >= stack) serious = { level: i + 1, at: t };
      t += l.minutes + (breakEvery > 0 && (i + 1) % breakEvery === 0 && i < levels.length - 1 ? breakMinutes : 0);
    });
    return { total: t, serious: serious as { level: number; at: number } | null };
  }, [levels, stack, breakEvery, breakMinutes]);
  return (
    <div className="blind-summary">
      {facts.serious ? (
        <span>
          All-in pressure (big blind ≥ 20% of a stack) from <b>level {facts.serious.level}</b>, after <b>{fmtDuration(facts.serious.at)}</b>
        </span>
      ) : (
        <span>Stacks stay deep through every level</span>
      )}
      <span className="muted">The whole structure runs {fmtDuration(facts.total)} at most, breaks included</span>
    </div>
  );
}

/** A small bar chart of the big blind at each level (log scale), so the curve is easy to see. */
function BlindChart({ levels }: { levels: BlindLevel[] }) {
  if (levels.length === 0) return null;
  const max = Math.log10(Math.max(...levels.map((l) => Math.max(1, l.bigBlind || 1))));
  const min = Math.log10(Math.max(1, Math.min(...levels.map((l) => l.bigBlind || 1))));
  const w = 100 / levels.length;
  return (
    <svg className="blind-chart" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label="Big blind by level">
      {levels.map((l, i) => {
        const v = Math.log10(Math.max(1, l.bigBlind || 1));
        const h = 4 + (max > min ? ((v - min) / (max - min)) * 25 : 12);
        return <rect key={i} x={i * w + w * 0.12} y={30 - h} width={w * 0.76} height={h} rx={0.6} className={l.ante > 0 ? "ante" : ""}>
          <title>{`Level ${i + 1}: ${fmt(l.smallBlind)}/${fmt(l.bigBlind)}${l.ante ? ` ante ${fmt(l.ante)}` : ""} · ${l.minutes} min`}</title>
        </rect>;
      })}
    </svg>
  );
}
