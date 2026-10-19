import { useEffect, useRef, useState } from "react";
import { chatRights } from "../shared/chatRights.ts";
import type { ChatChannel, ChatMessage } from "../shared/protocol.ts";
import { useGame } from "./game.tsx";

const MAX = 200;
const QUICK = ["gg", "nh", "ty", "gl", "😂", "😮", "🔥", "👏"];

/**
 * The chat for one board: players talk in "Board" (with the arbiter's game results). People watching
 * also get a "Spectators" tab that the players at the table never see.
 */
export function TableChat(p: {
  tournamentId: number;
  tableId: number;
  messages: ChatMessage[];
  spectatorMessages: ChatMessage[];
  seated: boolean;
  canSend: boolean;
  onClose: () => void;
}) {
  const { send, user } = useGame();
  const [text, setText] = useState("");
  const [showDealer, setShowDealer] = useState(true);
  const [tab, setTab] = useState<ChatChannel>("spectators");
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const rights = chatRights({ seated: p.seated, isAdmin: user.isAdmin });
  const channel: ChatChannel = p.seated ? "table" : tab;
  const source = channel === "table" ? p.messages : p.spectatorMessages;
  const shown = showDealer ? source : source.filter((m) => m.kind !== "dealer");
  const canPost = p.canSend && rights.post.includes(channel);
  const unseenOther = useUnseen({ table: p.messages.length, spectators: p.spectatorMessages.length }, channel);

  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, channel]);

  const say = (t: string) => {
    const clean = t.trim();
    if (!clean || !canPost) return;
    send({ type: "chat", tournamentId: p.tournamentId, tableId: p.tableId, channel, text: clean.slice(0, MAX) });
    setText("");
    stick.current = true;
  };

  const placeholder = !p.canSend
    ? "Chat opens when the match is running"
    : !canPost
      ? "Only players and the host talk here. Switch to Spectators."
      : channel === "table" && !p.seated
        ? "Announce to the players as Host…"
        : channel === "spectators"
          ? "Chat with other spectators…"
          : "Say something nice…";

  return (
    <div className="chat">
      <div className="chat-head">
        {p.seated ? (
          <strong>Board chat</strong>
        ) : (
          <span className="chat-tabs" role="tablist">
            {(["spectators", "table"] as const).map((c) => (
              <button key={c} role="tab" aria-selected={tab === c} className={tab === c ? "active" : ""} onClick={() => setTab(c)}>
                {c === "table" ? "Board" : "Spectators"}
                {tab !== c && unseenOther > 0 && <span className="unread">{unseenOther > 9 ? "9+" : unseenOther}</span>}
              </button>
            ))}
          </span>
        )}
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
        {shown.length === 0 && (
          <div className="chat-empty muted small">
            {channel === "spectators" ? "Only people watching see this chat. The players can't." : "No messages yet. Say hi 👋"}
          </div>
        )}
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
                  {(m.admin || m.kind === "host") && <span className="chat-badge admin">Host</span>}
                  {m.kind === "spectator" && channel === "table" && <span className="chat-badge">watching</span>}
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
          <button key={q} onClick={() => say(q)} disabled={!canPost}>
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
          placeholder={placeholder}
          disabled={!canPost}
          maxLength={MAX}
          aria-label="Chat message"
        />
        <button className="btn primary" disabled={!canPost || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

/** Messages in the other tab since you last looked at it (history from before opening the chat counts as seen). */
function useUnseen(counts: Record<ChatChannel, number>, channel: ChatChannel) {
  const seen = useRef(counts);
  seen.current = { ...seen.current, [channel]: counts[channel] };
  const other: ChatChannel = channel === "table" ? "spectators" : "table";
  return Math.max(0, counts[other] - seen.current[other]);
}
