// Blind structures you save in the hub, per game, to reuse when creating events. The game checks the
// structure properly when an event is created; here we only make sure it's well-formed.

import type { BlindLevel, BlindPreset } from "../shared/protocol.ts";
import { db } from "./db.ts";

export class BlindPresetError extends Error {}

type Row = { id: number; name: string; levels_json: string; set_json: string };

export function listBlindPresets(gameKey: string): BlindPreset[] {
  return (db.prepare(`SELECT id, name, levels_json, set_json FROM blind_presets WHERE game_key = ? ORDER BY name`).all(gameKey) as Row[]).map((r) => ({
    id: `saved-${r.id}`,
    name: r.name,
    levels: JSON.parse(r.levels_json) as BlindLevel[],
    set: JSON.parse(r.set_json) as Record<string, number>,
    saved: true,
  }));
}

export function saveBlindPreset(gameKey: string, input: { name?: unknown; levels?: unknown; set?: unknown }): BlindPreset {
  const name = String(input.name ?? "").trim().slice(0, 60);
  if (!name) throw new BlindPresetError("Give the preset a name");
  if (!Array.isArray(input.levels) || input.levels.length === 0 || input.levels.length > 60) throw new BlindPresetError("A preset needs 1–60 levels");
  const whole = (v: unknown) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0) throw new BlindPresetError("Blind levels must be whole numbers");
    return n;
  };
  const levels: BlindLevel[] = input.levels.map((l: Partial<BlindLevel>) => ({
    smallBlind: whole(l?.smallBlind),
    bigBlind: whole(l?.bigBlind),
    ante: whole(l?.ante ?? 0),
    minutes: whole(l?.minutes),
  }));
  const set: Record<string, number> = {};
  if (input.set && typeof input.set === "object") {
    for (const [k, v] of Object.entries(input.set as Record<string, unknown>).slice(0, 20)) {
      if (/^[a-zA-Z]{1,40}$/.test(k) && Number.isFinite(Number(v))) set[k] = Number(v);
    }
  }
  // Saving under an existing name replaces it, so "Friday Turbo" can be tweaked over time.
  const existing = db.prepare(`SELECT id FROM blind_presets WHERE game_key = ? AND name = ?`).get(gameKey, name) as { id: number } | undefined;
  if (existing) {
    db.prepare(`UPDATE blind_presets SET levels_json = ?, set_json = ? WHERE id = ?`).run(JSON.stringify(levels), JSON.stringify(set), existing.id);
    return { id: `saved-${existing.id}`, name, levels, set, saved: true };
  }
  const { id } = db
    .prepare(`INSERT INTO blind_presets (game_key, name, levels_json, set_json, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id`)
    .get(gameKey, name, JSON.stringify(levels), JSON.stringify(set), Date.now()) as { id: number };
  return { id: `saved-${id}`, name, levels, set, saved: true };
}

export function deleteBlindPreset(id: number) {
  db.prepare(`DELETE FROM blind_presets WHERE id = ?`).run(id);
}
