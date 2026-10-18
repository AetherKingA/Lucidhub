import { useState } from "react";
import type { Prize, PrizeType } from "../shared/protocol.ts";
import { api, placeLabel } from "./api.ts";
import { Empty, PageHeader, useAction, useHub } from "./ui.tsx";

const DEFAULT_MESSAGE: Record<PrizeType, string> = {
  code_pool: "Congratulations {user}! You placed #{place} in **{event}** and won **{prize}**.\n\nYour code: ```{code}```",
  message: "Congratulations {user}! You placed #{place} in **{event}** and won **{prize}**.",
};

export function PrizesPage() {
  const { prizes, templates, reload } = useHub();
  const [editing, setEditing] = useState<Prize | "new" | null>(null);
  const [codesFor, setCodesFor] = useState<Prize | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const { run } = useAction();
  const shown = prizes.filter((p) => showArchived || !p.archived);

  return (
    <>
      <PageHeader title="Prizes" sub="A code pool hands each winner the next unused code. A message prize sends the same text to every winner.">
        <button className="btn primary" onClick={() => setEditing("new")}>
          + New prize
        </button>
      </PageHeader>

      {editing && <PrizeForm prize={editing === "new" ? null : editing} onDone={() => { setEditing(null); void reload(); }} />}
      {codesFor && <CodesPanel prize={codesFor} onDone={() => { setCodesFor(null); void reload(); }} />}

      <section className="card">
        {shown.length === 0 ? (
          <Empty>No prizes yet. Create one — e.g. "Steam key" as a code pool, then paste in your keys.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Prize</th>
                <th>Type</th>
                <th>Stock</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} className={p.archived ? "dim" : ""}>
                  <td>
                    <strong>{p.name}</strong>
                    {p.archived && <span className="muted small"> (archived)</span>}
                  </td>
                  <td className="muted">{p.type === "code_pool" ? "Code pool" : "Message"}</td>
                  <td>
                    {p.type === "code_pool" ? (
                      <span className={p.stock === 0 ? "bad" : p.stock <= p.lowStockThreshold ? "warn" : "ok"}>
                        {p.stock} left <span className="muted small">· {p.usedCodes} given out</span>
                      </span>
                    ) : (
                      <span className="muted">Unlimited</span>
                    )}
                  </td>
                  <td className="actions">
                    {p.type === "code_pool" && (
                      <button className="btn ghost small-btn" onClick={() => setCodesFor(p)}>
                        Add codes
                      </button>
                    )}
                    <button className="link" onClick={() => setEditing(p)}>
                      Edit
                    </button>
                    <button className="link" onClick={() => run(async () => { await api(`/api/prizes/${p.id}`, { method: "PATCH", body: { archived: !p.archived } }); await reload(); })}>
                      {p.archived ? "Restore" : "Archive"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {prizes.some((p) => p.archived) && (
          <button className="link small" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? "Hide archived" : "Show archived"}
          </button>
        )}
      </section>

      <section className="card">
        <h3>Saved prize ladders</h3>
        {templates.length === 0 ? (
          <Empty>Build a ladder on an event and click "Save as reusable ladder" to reuse it on future events.</Empty>
        ) : (
          <ul className="list">
            {templates.map((t) => (
              <li key={t.id}>
                <strong>{t.name}</strong>
                <span className="muted small">
                  {t.rules.map((r) => `${placeLabel(r.placeFrom, r.placeTo)}: ${prizes.find((p) => p.id === r.prizeId)?.name ?? "?"}`).join(" · ")}
                </span>
                <button className="link danger" onClick={() => confirm(`Delete "${t.name}"?`) && run(async () => { await api(`/api/templates/${t.id}`, { method: "DELETE" }); await reload(); })}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function PrizeForm({ prize, onDone }: { prize: Prize | null; onDone: () => void }) {
  const [type, setType] = useState<PrizeType>(prize?.type ?? "code_pool");
  const [name, setName] = useState(prize?.name ?? "");
  const [message, setMessage] = useState(prize?.message ?? DEFAULT_MESSAGE.code_pool);
  const [imageUrl, setImageUrl] = useState(prize?.imageUrl ?? "");
  const [threshold, setThreshold] = useState(prize?.lowStockThreshold ?? 2);
  const [codes, setCodes] = useState("");
  const { busy, run } = useAction();

  const pickType = (t: PrizeType) => {
    if (message === DEFAULT_MESSAGE[type]) setMessage(DEFAULT_MESSAGE[t]);
    setType(t);
  };

  const preview = message
    .replace(/\{user\}/g, "@Winner")
    .replace(/\{place\}/g, "1")
    .replace(/\{event\}/g, "Friday Poker Night")
    .replace(/\{prize\}/g, name || "Prize")
    .replace(/\{code\}/g, "ABCD-1234-EFGH");

  const save = () =>
    run(async () => {
      const body = { name, type, message, imageUrl: imageUrl || null, lowStockThreshold: threshold };
      if (prize) await api(`/api/prizes/${prize.id}`, { method: "PATCH", body });
      else await api("/api/prizes", { body: { ...body, codes } });
      onDone();
    }, prize ? "Prize saved" : "Prize created");

  return (
    <section className="card panel">
      <h3>{prize ? `Edit ${prize.name}` : "New prize"}</h3>
      {!prize && (
        <div className="seg">
          <button className={type === "code_pool" ? "active" : ""} onClick={() => pickType("code_pool")}>
            Code pool <small>game keys, gift cards…</small>
          </button>
          <button className={type === "message" ? "active" : ""} onClick={() => pickType("message")}>
            Message <small>a link, instructions…</small>
          </button>
        </div>
      )}
      <div className="form-grid">
        <label className="wide">
          <span>Name (shown in the public announcement)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. $25 Steam gift card" maxLength={80} />
        </label>
        <label className="wide">
          <span>
            DM to the winner — placeholders: <code>{"{user}"}</code> <code>{"{place}"}</code> <code>{"{event}"}</code> <code>{"{prize}"}</code>
            {type === "code_pool" && <> <code>{"{code}"}</code></>}
          </span>
          <textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1800} />
        </label>
        <label>
          <span>Image link (optional)</span>
          <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" />
        </label>
        {type === "code_pool" && (
          <label>
            <span>Warn me when stock is at or below</span>
            <input type="number" min={0} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          </label>
        )}
        {type === "code_pool" && !prize && (
          <label className="wide">
            <span>Codes — one per line, or paste a CSV (first column is used)</span>
            <textarea rows={5} className="mono" value={codes} onChange={(e) => setCodes(e.target.value)} placeholder={"AAAA-BBBB-CCCC\nDDDD-EEEE-FFFF"} />
          </label>
        )}
      </div>
      <div className="dm-preview">
        <div className="muted small">Preview of the DM</div>
        <div className="embed">
          <strong>🏆 You won: {name || "Prize"}</strong>
          <p>{preview}</p>
        </div>
      </div>
      <div className="row end">
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy} onClick={save}>
          {prize ? "Save" : "Create prize"}
        </button>
      </div>
    </section>
  );
}

function CodesPanel({ prize, onDone }: { prize: Prize; onDone: () => void }) {
  const [text, setText] = useState("");
  const { toast } = useHub();
  const { busy, run } = useAction();

  const readFile = async (f: File | undefined) => {
    if (f) setText(await f.text());
  };

  return (
    <section className="card panel">
      <h3>Add codes to {prize.name}</h3>
      <p className="muted small">
        {prize.stock} unused, {prize.usedCodes} given out. Duplicates are skipped. Winners waiting for this prize get theirs right away.
      </p>
      <textarea rows={8} className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder="One code per line" />
      <div className="row between">
        <label className="btn ghost small-btn">
          Upload .txt / .csv
          <input type="file" accept=".txt,.csv,text/plain,text/csv" hidden onChange={(e) => void readFile(e.target.files?.[0])} />
        </label>
        <div className="row">
          {prize.stock > 0 && (
            <button
              className="link danger"
              onClick={() =>
                confirm(`Remove all ${prize.stock} unused codes from ${prize.name}? Codes already given out are kept.`) &&
                run(async () => {
                  await api(`/api/prizes/${prize.id}/codes`, { method: "DELETE" });
                  onDone();
                }, "Unused codes removed")
              }
            >
              Remove unused codes
            </button>
          )}
          <button className="btn ghost" onClick={onDone}>
            Close
          </button>
          <button
            className="btn primary"
            disabled={busy || !text.trim()}
            onClick={() =>
              run(async () => {
                const r = await api<{ added: number; duplicates: number; filled: number }>(`/api/prizes/${prize.id}/codes`, { body: { text } });
                toast(`Added ${r.added} code${r.added === 1 ? "" : "s"}${r.duplicates ? ` (${r.duplicates} duplicate skipped)` : ""}${r.filled ? ` — ${r.filled} sent to waiting winners` : ""}`);
                onDone();
              })
            }
          >
            Add codes
          </button>
        </div>
      </div>
    </section>
  );
}
