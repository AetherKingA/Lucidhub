// Prizes, their code pools, and reusable prize ladders (templates).

import type { Prize, PrizeRule, PrizeType, Template } from "../shared/protocol.ts";
import { db, tx } from "./db.ts";

export class PrizeInputError extends Error {}

type PrizeDbRow = {
  id: number;
  name: string;
  type: PrizeType;
  message: string;
  image_url: string | null;
  low_stock_threshold: number;
  archived: number;
  stock: number;
  used: number;
};

const PRIZE_SELECT = `
  SELECT p.*,
    (SELECT COUNT(*) FROM prize_codes c WHERE c.prize_id = p.id AND c.award_id IS NULL) AS stock,
    (SELECT COUNT(*) FROM prize_codes c WHERE c.prize_id = p.id AND c.award_id IS NOT NULL) AS used
  FROM prizes p`;

const toPrize = (r: PrizeDbRow): Prize => ({
  id: r.id,
  name: r.name,
  type: r.type,
  message: r.message,
  imageUrl: r.image_url,
  lowStockThreshold: r.low_stock_threshold,
  archived: r.archived === 1,
  stock: r.stock,
  usedCodes: r.used,
});

export function listPrizes(includeArchived = false): Prize[] {
  const where = includeArchived ? "" : "WHERE p.archived = 0";
  return (db.prepare(`${PRIZE_SELECT} ${where} ORDER BY p.archived, p.name`).all() as PrizeDbRow[]).map(toPrize);
}

export function getPrize(id: number): Prize | null {
  const r = db.prepare(`${PRIZE_SELECT} WHERE p.id = ?`).get(id) as PrizeDbRow | undefined;
  return r ? toPrize(r) : null;
}

export const DEFAULT_MESSAGES: Record<PrizeType, string> = {
  code_pool: "Congratulations {user}! You placed #{place} in **{event}** and won **{prize}**.\n\nYour code: ```{code}```",
  message: "Congratulations {user}! You placed #{place} in **{event}** and won **{prize}**.",
};

export interface PrizeInput {
  name: string;
  type: PrizeType;
  message?: string;
  imageUrl?: string | null;
  lowStockThreshold?: number;
}

function cleanInput(input: PrizeInput, existing?: Prize) {
  const name = String(input.name ?? existing?.name ?? "").trim().slice(0, 80);
  if (!name) throw new PrizeInputError("Give the prize a name");
  const type = existing?.type ?? input.type;
  if (type !== "code_pool" && type !== "message") throw new PrizeInputError("Pick a prize type");
  const message = String(input.message ?? existing?.message ?? "").trim().slice(0, 1800) || DEFAULT_MESSAGES[type];
  if (type === "code_pool" && !message.includes("{code}")) throw new PrizeInputError("The message must include {code} so the winner gets their code");
  const imageUrl = (input.imageUrl ?? existing?.imageUrl ?? "")?.trim() || null;
  if (imageUrl && !/^https:\/\/\S+$/.test(imageUrl)) throw new PrizeInputError("Image must be an https:// link");
  const threshold = Math.max(0, Math.min(1000, Math.round(Number(input.lowStockThreshold ?? existing?.lowStockThreshold ?? 2)) || 0));
  return { name, type, message, imageUrl, threshold };
}

export function createPrize(input: PrizeInput): Prize {
  const p = cleanInput(input);
  const { id } = db
    .prepare(`INSERT INTO prizes (name, type, message, image_url, low_stock_threshold, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(p.name, p.type, p.message, p.imageUrl, p.threshold, Date.now()) as { id: number };
  return getPrize(id)!;
}

export function updatePrize(id: number, input: Partial<PrizeInput> & { archived?: boolean }): Prize {
  const existing = getPrize(id);
  if (!existing) throw new PrizeInputError("Prize not found");
  const p = cleanInput({ ...existing, ...input } as PrizeInput, existing);
  db.prepare(`UPDATE prizes SET name = ?, message = ?, image_url = ?, low_stock_threshold = ?, archived = ? WHERE id = ?`).run(
    p.name,
    p.message,
    p.imageUrl,
    p.threshold,
    Number(input.archived ?? existing.archived),
    id,
  );
  return getPrize(id)!;
}

/** Splits pasted text or a CSV (first column) into codes, one per line. */
export function parseCodes(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    let code = line.split(/[,\t;]/)[0]!.trim().replace(/^"(.*)"$/, "$1").trim();
    if (!code || /^code$/i.test(code)) continue;
    code = code.slice(0, 500);
    out.push(code);
  }
  return out;
}

/** Adds codes to a pool, skipping duplicates. Returns how many were new. */
export function addCodes(prizeId: number, codes: string[]): { added: number; duplicates: number } {
  const prize = getPrize(prizeId);
  if (!prize) throw new PrizeInputError("Prize not found");
  if (prize.type !== "code_pool") throw new PrizeInputError("Only code-pool prizes hold codes");
  const insert = db.prepare(`INSERT INTO prize_codes (prize_id, code, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`);
  const now = Date.now();
  let added = 0;
  tx(() => {
    for (const code of new Set(codes)) added += Number(insert.run(prizeId, code, now).changes);
  });
  db.prepare(`UPDATE prizes SET low_stock_alerted = 0 WHERE id = ?`).run(prizeId);
  return { added, duplicates: codes.length - added };
}

/** Unused codes can be removed (e.g. pasted by mistake). Codes already given out stay for the record. */
export function removeUnusedCodes(prizeId: number): number {
  return Number(db.prepare(`DELETE FROM prize_codes WHERE prize_id = ? AND award_id IS NULL`).run(prizeId).changes);
}

export function listUnusedCodes(prizeId: number): string[] {
  return (db.prepare(`SELECT code FROM prize_codes WHERE prize_id = ? AND award_id IS NULL ORDER BY id`).all(prizeId) as { code: string }[]).map((r) => r.code);
}

// ---------------------------------------------------------------- rules + templates

/** Validates a prize ladder: places are 1-based, ranges are ordered, and every prize exists. */
export function cleanRules(rules: PrizeRule[]): PrizeRule[] {
  if (!Array.isArray(rules)) throw new PrizeInputError("Prize ladder must be a list");
  if (rules.length > 100) throw new PrizeInputError("That's a lot of rules — keep it under 100");
  return rules.map((r, i) => {
    const placeFrom = Math.round(Number(r.placeFrom));
    const placeTo = Math.round(Number(r.placeTo ?? r.placeFrom));
    if (!(placeFrom >= 1) || !(placeTo >= placeFrom) || placeTo > 100_000) throw new PrizeInputError(`Row ${i + 1}: places must run from 1 upward (e.g. 2 to 3)`);
    const prize = getPrize(Number(r.prizeId));
    if (!prize) throw new PrizeInputError(`Row ${i + 1}: pick a prize`);
    return { placeFrom, placeTo, prizeId: prize.id };
  });
}

export function listTemplates(): Template[] {
  return (db.prepare(`SELECT id, name, rules_json FROM templates ORDER BY name`).all() as { id: number; name: string; rules_json: string }[]).map((r) => ({
    id: r.id,
    name: r.name,
    rules: JSON.parse(r.rules_json) as PrizeRule[],
  }));
}

export function saveTemplate(input: { id?: number; name: string; rules: PrizeRule[] }): Template {
  const name = String(input.name ?? "").trim().slice(0, 60);
  if (!name) throw new PrizeInputError("Give the template a name");
  const rules = cleanRules(input.rules);
  if (input.id) {
    db.prepare(`UPDATE templates SET name = ?, rules_json = ? WHERE id = ?`).run(name, JSON.stringify(rules), input.id);
    return { id: input.id, name, rules };
  }
  const { id } = db.prepare(`INSERT INTO templates (name, rules_json) VALUES (?, ?) RETURNING id`).get(name, JSON.stringify(rules)) as { id: number };
  return { id, name, rules };
}

export function deleteTemplate(id: number) {
  db.prepare(`DELETE FROM templates WHERE id = ?`).run(id);
}
