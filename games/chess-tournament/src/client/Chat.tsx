import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../shared/protocol.ts";
import { useGame } from "./game.tsx";

const MAX = 200;
const QUICK = ["gg", "nh", "ty", "gl", "😂", "😮", "🔥", "👏"];

/** The chat for one table: players and people watching, plus the arbiter's game results. */
export function TableChat(p: { tournamentId: number; tableId: number; messages: ChatMessage[]; canSend: boolean; onClose: () => void }) {
  const { send, user } = useGame();
  const [text, setText] = useState("");
  const [showDealer, setShowDealer] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const shown = showDealer ? p.messages : p.messages.filter((m) => m.kind !== "dealer");

  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  const say = (t: string) => {
    const clean = t.trim();
    if (!clean || !p.canSend) return;
    send({ type: "chat", tournamentId: p.tournamentId, tableId: p.tableId, text: clean.slice(0, MAX) });
    setText("");
    stick.current = true;
  };

  return (
    <div className="chat">
      <div className="chat-head">
        <strong>Table chat</strong>
        <label className="chat-filter" title="Show game results and draw offers">
          <input type="checkbox" checked={showDealer} onChange={(e) => setShowDealer(e.target.checked)} /> Arbiter
        </label>
        <button className="icon-btn" onClick={p.onClose} title="Hide chat">
          ✕
        </button>
      </div>
      <div
        className="chat-list"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {shown.length === 0 && <div className="chat-empty muted small">No messages yet. Say hi 👋</div>}
        {shown.map((m) =>
          m.kind === "dealer" ? (
            <div key={m.id} className="chat-msg from-dealer">
              <span className="dealer-chip">A</span>
              <span>{m.text}</span>
            </div>
          ) : (
            <div key={m.id} className={`chat-msg ${m.userId === user.id ? "mine" : ""}`}>
              {m.avatarUrl && <img src={m.avatarUrl} alt="" width={22} height={22} />}
              <div className="chat-body">
                <span className="chat-name">
                  {m.username}
                  {m.admin && <span className="chat-badge admin">Host</span>}
                  {m.kind === "spectator" && <span className="chat-badge">watching</span>}
                  <span className="chat-time">{new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                </span>
                <span className="chat-text">{m.text}</span>
              </div>
            </div>
          ),
        )}
      </div>
      <div className="chat-quick">
        {QUICK.map((q) => (
          <button key={q} onClick={() => say(q)} disabled={!p.canSend}>
            {q}
          </button>
        ))}
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          say(text);
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX))}
          placeholder={p.canSend ? "Say something nice…" : "Chat opens when the table is running"}
          disabled={!p.canSend}
          maxLength={MAX}
          aria-label="Chat message"
        />
        <button className="btn primary" disabled={!p.canSend || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
