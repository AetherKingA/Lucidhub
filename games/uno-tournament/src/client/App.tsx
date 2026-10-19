import { useEffect, useState } from "react";
import type { UserInfo } from "../shared/protocol.ts";
import { GameProvider, useGame } from "./game.tsx";
import { Lobby } from "./Lobby.tsx";
import { navigate, rememberPage, restorePage, useRoute } from "./router.ts";
import { TablePage } from "./TablePage.tsx";
import { TournamentPage } from "./TournamentPage.tsx";

export const SITE_NAME = "Uno Night";

const LOGIN_ERRORS: Record<string, string> = {
  unverified: "Your Discord account needs a verified email address. Verify it in Discord settings, then try again.",
  banned: "This account has been banned from the site.",
  cancelled: "Discord login was cancelled.",
  login_failed: "Something went wrong signing in with Discord. Please try again.",
  not_configured: "Discord login isn't set up on this server yet (the host needs to finish LucidHub's setup).",
};

type MeState = { status: "loading" } | { status: "signedOut" } | { status: "signedIn"; user: UserInfo };

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
  return (
    <GameProvider user={me.user}>
      <Shell onLogout={() => setMe({ status: "signedOut" })} />
    </GameProvider>
  );
}

function Login({ error }: { error: string | null }) {
  return (
    <main className="center">
      <div className="card login">
        <div className="logo" aria-hidden="true">
          <span className="logo-card red">U</span>
          <span className="logo-card yellow">N</span>
          <span className="logo-card green">O</span>
        </div>
        <h1>{SITE_NAME}</h1>
        <p className="muted">Uno tournaments with your Discord friends. Win your table, move on, take the final.</p>
        {error && <p className="error">{error}</p>}
        <a className="btn discord" href="/auth/discord" onClick={rememberPage}>
          <DiscordIcon /> Sign in with Discord
        </a>
        <p className="fine">One account per Discord account. Your Discord email must be verified.</p>
      </div>
    </main>
  );
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const { user, status, online, notices, dismiss } = useGame();
  const route = useRoute();

  const logout = async () => {
    await fetch("/auth/logout", { method: "POST" });
    onLogout();
  };

  return (
    <div className={`shell ${route.page === "table" ? "at-table" : ""}`}>
      <header className="topbar">
        <a className="brand" href="#/" onClick={() => navigate("/")}>
          <span className="brand-mark">UNO</span> Night
        </a>
        <span className={`status ${status}`}>
          {status === "open" ? `${online} online` : status === "connecting" ? "Connecting…" : "Server offline — reconnecting"}
        </span>
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
      {route.page === "table" && <TablePage tournamentId={route.tournamentId} tableId={route.tableId} />}

      <div className="notices" role="status">
        {notices.map((n) => (
          <button key={n.id} className={`notice ${n.kind}`} onClick={() => dismiss(n.id)}>
            {n.text}
          </button>
        ))}
      </div>
    </div>
  );
}

function DiscordIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 127 96" aria-hidden="true">
      <path
        fill="currentColor"
        d="M107.7 8.07A105 105 0 0 0 81.47 0a72 72 0 0 0-3.36 6.83 97.7 97.7 0 0 0-29.11 0A72 72 0 0 0 45.64 0a105.9 105.9 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.7 105.7 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.4 68.4 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.6 75.6 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.7 68.7 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.3 105.3 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z"
      />
    </svg>
  );
}
