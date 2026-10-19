import { type ReactNode, createContext, useContext, useEffect, useRef, useState } from "react";
import type { ChatMessage, ClientMessage, FollowInfo, ServerMessage, TableView, TournamentSummary, UserInfo } from "../shared/protocol.ts";
import { navigate, useRoute } from "./router.ts";
import { type SocketStatus, useSocket } from "./useSocket.ts";

export interface Notice {
  id: number;
  text: string;
  kind: "info" | "error" | "success";
}

interface Game {
  user: UserInfo;
  status: SocketStatus;
  online: number;
  tournaments: TournamentSummary[];
  tables: Record<string, TableView>;
  /** Recent chat per table, keyed like tables. */
  chats: Record<string, ChatMessage[]>;
  /** The spectators' chat per board (never sent to the players there). */
  spectatorChats: Record<string, ChatMessage[]>;
  /** People watching each board, keyed like tables. */
  viewers: Record<string, number>;
  /** Who you're following, per tournament id. */
  follows: Record<number, FollowInfo | null>;
  send: (msg: ClientMessage) => void;
  /** Current time on the server's clock (corrects for a wrong PC clock). */
  serverNow: () => number;
  notices: Notice[];
  notify: (text: string, kind?: Notice["kind"]) => void;
  dismiss: (id: number) => void;
}

const GameContext = createContext<Game | null>(null);

export function useGame() {
  const g = useContext(GameContext);
  if (!g) throw new Error("useGame outside GameProvider");
  return g;
}

export const tableKey = (tournamentId: number, tableId: number) => `${tournamentId}:${tableId}`;

let noticeId = 0;

export function GameProvider({ user, children }: { user: UserInfo; children: ReactNode }) {
  const [online, setOnline] = useState(0);
  const [tournaments, setTournaments] = useState<TournamentSummary[]>([]);
  const [tables, setTables] = useState<Record<string, TableView>>({});
  const [chats, setChats] = useState<Record<string, ChatMessage[]>>({});
  const [spectatorChats, setSpectatorChats] = useState<Record<string, ChatMessage[]>>({});
  const [viewers, setViewers] = useState<Record<string, number>>({});
  const [follows, setFollows] = useState<Record<number, FollowInfo | null>>({});
  const [notices, setNotices] = useState<Notice[]>([]);
  const offset = useRef(0);
  const route = useRoute();
  const routeRef = useRef(route);
  routeRef.current = route;

  const notify = (text: string, kind: Notice["kind"] = "info") => {
    const id = ++noticeId;
    setNotices((n) => [...n.slice(-3), { id, text, kind }]);
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), kind === "error" ? 5000 : 7000);
  };

  const syncClock = (serverNow: number) => {
    offset.current = serverNow - Date.now();
  };

  const { status, send } = useSocket((msg: ServerMessage) => {
    switch (msg.type) {
      case "hello":
        setOnline(msg.online);
        syncClock(msg.serverNow);
        break;
      case "online":
        setOnline(msg.count);
        break;
      case "lobby":
        syncClock(msg.serverNow);
        setTournaments(msg.tournaments);
        break;
      case "table":
        syncClock(msg.view.serverNow);
        setTables((t) => ({ ...t, [tableKey(msg.view.tournamentId, msg.view.tableId)]: msg.view }));
        break;
      case "tableClosed":
        setTables((t) => {
          const next = { ...t };
          delete next[tableKey(msg.tournamentId, msg.tableId)];
          return next;
        });
        break;
      case "moved": {
        // Follow the player to their new table if they're looking at this tournament.
        const r = routeRef.current;
        if (r.tournamentId === msg.tournamentId || r.page === "lobby") {
          const wasAtTable = r.page === "table";
          navigate(`/t/${msg.tournamentId}/table/${msg.tableId}`);
          if (wasAtTable) notify(`Your next match is on board ${msg.tableId}.`);
        } else notify(`Your match is ready on board ${msg.tableId}.`);
        break;
      }
      case "finished":
        notify(
          msg.place === 1 ? "🏆 You won the tournament!" : `You finished in ${ordinal(msg.place)} place.`,
          "success",
        );
        break;
      case "advanced": {
        const how = msg.bye ? "You have a bye" : "🎉 You won your match";
        notify(
          msg.round === msg.totalRounds ? `${how}! You're through to the final.` : `${how}! You're through to round ${msg.round} of ${msg.totalRounds}.`,
          "success",
        );
        break;
      }
      case "error":
        notify(msg.message, "error");
        break;
      case "chat": {
        const k = tableKey(msg.tournamentId, msg.tableId);
        const set = msg.channel === "spectators" ? setSpectatorChats : setChats;
        set((c) => ({ ...c, [k]: msg.replace ? msg.messages : [...(c[k] ?? []), ...msg.messages].slice(-120) }));
        break;
      }
      case "viewers":
        setViewers((v) => ({ ...v, [tableKey(msg.tournamentId, msg.tableId)]: msg.count }));
        break;
      case "follow": {
        setFollows((f) => ({ ...f, [msg.tournamentId]: msg.following }));
        if (msg.notice) notify(msg.notice, msg.following ? "info" : "success");
        // Take a follower watching this tournament to the board their player just sat down at.
        const r = routeRef.current;
        const to = msg.following?.tableId;
        if (to != null && r.page === "table" && r.tournamentId === msg.tournamentId && r.tableId !== to) navigate(`/t/${msg.tournamentId}/table/${to}`);
        break;
      }
    }
  });

  const game: Game = {
    user,
    status,
    online,
    tournaments,
    tables,
    chats,
    spectatorChats,
    viewers,
    follows,
    send,
    serverNow: () => Date.now() + offset.current,
    notices,
    notify,
    dismiss: (id) => setNotices((n) => n.filter((x) => x.id !== id)),
  };
  return <GameContext.Provider value={game}>{children}</GameContext.Provider>;
}

export function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]!);
}

/** Re-renders every `ms` and returns the current server time. */
export function useServerNow(ms = 250) {
  const { serverNow } = useGame();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return serverNow();
}

export function formatClock(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

