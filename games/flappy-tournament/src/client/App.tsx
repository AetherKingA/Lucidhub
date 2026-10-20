import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ClientMessage, ServerMessage, TournamentSummary, TournamentView, UserInfo } from "../shared/protocol.ts";
import { Lobby } from "./Lobby.tsx";
import { navigate, rememberPage, restorePage, useRoute } from "./router.ts";
import { TournamentPage } from "./TournamentPage.tsx";
import { type SocketStatus, useSocket } from "./useSocket.ts";

export const SITE_NAME = "Flappy Night";

const LOGIN_ERRORS: Record<string, string> = {
  unverified: "Your Discord account needs a verified email address. Verify it in Discord settings, then try again.",
  banned: "This account has been banned from the site.",
  cancelled: "Discord login was cancelled.",
  login_failed: "Something went wrong signing in with Discord. Please try again.",
  not_configured: "Discord login isn't set up on this server yet (the host needs to finish LucidHub's setup).",
};

type MeState = { status: "loading" } | { status: "signedOut" } | { status: "signedIn"; user: UserInfo };

export interface Notice {
  id: number;
  text: string;
  kind: "info" | "error";
}

interface GameState {
  user: UserInfo;
  status: SocketStatus;
  tournaments: TournamentSummary[];
  view: TournamentView | null;
  /** Server time minus local time, so clocks agree. */
  offset: number;
  send: (msg: ClientMessage) => void;
  open: (tournamentId: number | null) => void;
  /** Run messages for the game screen. */
  onRun: React.RefObject<((msg: ServerMessage) => void) | null>;
  notify: (text: string, kind?: Notice["kind"]) => void;
}

const GameContext = createContext<GameState | null>(null);
export const useGame = () => useContext(GameContext)!;
/** Server time now. */
export const serverNow = (offset: number) => Date.now() + offset;

export function App() {
  const [me, setMe] = useState<MeState>({ status: "loading" });
  const [error] = useState(() => {
    const code = new URLSearchParams(location.search).get("error");
    if (code) history.replaceState(null, "", location.pathname + location.hash);
    return code ? (LOGIN_ERRORS[code] ?? LOGIN_ERRORS.login_failed!) : null;
  });

  useEffect(() => {
    fetch("/api/me")
      .then(async (r) => {
        if (!r.ok) return setMe({ status: "signedOut" });
        restorePage();
        setMe({ status: "signedIn", user: await r.json() });
      })
      .catch(() => setMe({ status: "signedOut" }));
  }, []);

  if (me.status === "loading") return <div className="center muted">Loading…</div>;
  if (me.status === "signedOut") return <Login error={error} />;
  return <Shell user={me.user} onLogout={() => setMe({ status: "signedOut" })} />;
}

function Login({ error }: { error: string | null }) {
  return (
    <main className="center">
      <div className="card login">
        <div className="logo" aria-hidden="true">🐤</div>
        <h1>{SITE_NAME}</h1>
        <p className="muted">Timed Flappy Bird tournaments with your Discord friends. Retry as much as you like, and your best flight counts. Then watch everyone's ghosts race.</p>
        {error && <p className="error">{error}</p>}
        <a className="btn discord" href="/auth/discord" onClick={rememberPage}>
          Sign in with Discord
        </a>
        <p className="fine">One account per Discord account. Your Discord email must be verified.</p>
      </div>
    </main>
  );
}

function Shell({ user, onLogout }: { user: UserInfo; onLogout: () => void }) {
  const route = useRoute();
  const [tournaments, setTournaments] = useState<TournamentSummary[]>([]);
  const [view, setView] = useState<TournamentView | null>(null);
  const [offset, setOffset] = useState(0);
  const [notices, setNotices] = useState<Notice[]>([]);
  const openId = route.page === "tournament" ? route.tournamentId : null;
  const openRef = useRef(openId);
  openRef.current = openId;
  const onRun = useRef<((msg: ServerMessage) => void) | null>(null);

  const notify = useCallback((text: string, kind: Notice["kind"] = "info") => {
    const id = Math.random();
    setNotices((n) => [...n.slice(-3), { id, text, kind }]);
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 5000);
  }, []);

  const { status, send } = useSocket(
    (msg) => {
      if ("serverNow" in msg && msg.type !== "pong") setOffset(msg.serverNow - Date.now());
      switch (msg.type) {
        case "lobby":
          setTournaments(msg.tournaments);
          break;
        case "tournament":
          if (msg.view.id === openRef.current) setView(msg.view);
          break;
        case "runStarted":
        case "runSaved":
          onRun.current?.(msg);
          break;
        case "error":
          notify(msg.message, "error");
          onRun.current?.(msg);
          break;
      }
    },
    () => send({ type: "open", tournamentId: openRef.current }),
  );

  useEffect(() => {
    setView(null);
    send({ type: "open", tournamentId: openId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  const logout = async () => {
    await fetch("/auth/logout", { method: "POST" });
    onLogout();
  };

  const state: GameState = { user, status, tournaments, view, offset, send, open: (id) => send({ type: "open", tournamentId: id }), onRun, notify };

  return (
    <GameContext.Provider value={state}>
      <div className="shell">
        <header className="topbar">
          <a className="brand" href="#/" onClick={() => navigate("/")}>
            <span className="brand-mark" aria-hidden="true">🐤</span> Flappy Night
          </a>
          <span className={`status ${status}`}>{status === "open" ? "Connected" : status === "connecting" ? "Connecting…" : "Server offline, reconnecting"}</span>
          <span className="me">
            <img src={user.avatarUrl} alt="" width={28} height={28} />
            <span className="me-name">{user.username}</span>
            {user.isAdmin && <span className="badge">Admin</span>}
            <button className="link" onClick={logout}>
              Sign out
            </button>
          </span>
        </header>

        {route.page === "lobby" && <Lobby />}
        {route.page === "tournament" && <TournamentPage id={route.tournamentId} watch={route.watch} />}

        <div className="notices" role="status">
          {notices.map((n) => (
            <button key={n.id} className={`notice ${n.kind}`} onClick={() => setNotices((all) => all.filter((x) => x.id !== n.id))}>
              {n.text}
            </button>
          ))}
        </div>
      </div>
    </GameContext.Provider>
  );
}
