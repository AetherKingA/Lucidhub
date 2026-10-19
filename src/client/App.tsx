import { useEffect, useState } from "react";
import type { AdminInfo } from "../shared/protocol.ts";
import { AwardsPage } from "./Awards.tsx";
import { EventPage, EventsPage, NewEventPage } from "./Events.tsx";
import { GamesPage } from "./Games.tsx";
import { OverviewPage } from "./Overview.tsx";
import { PrizesPage } from "./Prizes.tsx";
import { type Page, useRoute } from "./router.ts";
import { SettingsPage } from "./Settings.tsx";
import { HubProvider, useHub } from "./ui.tsx";

const LOGIN_ERRORS: Record<string, string> = {
  not_admin: "That Discord account isn't a LucidHub admin. Add its ID to ADMIN_DISCORD_IDS in the hub's .env and restart.",
  cancelled: "Discord login was cancelled.",
  login_failed: "Something went wrong signing in with Discord. Please try again.",
  not_configured: "Discord login isn't set up yet — fill in DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET (see SETUP.md).",
};

type MeState = { status: "loading" } | { status: "signedOut" } | { status: "signedIn"; admin: AdminInfo };

export function App() {
  const [me, setMe] = useState<MeState>({ status: "loading" });
  const [error] = useState(() => {
    const code = new URLSearchParams(location.search).get("error");
    if (code) history.replaceState(null, "", location.pathname + location.hash);
    return code ? (LOGIN_ERRORS[code] ?? LOGIN_ERRORS.login_failed!) : null;
  });

  useEffect(() => {
    fetch("/api/me")
      .then(async (r) => (r.ok ? setMe({ status: "signedIn", admin: await r.json() }) : setMe({ status: "signedOut" })))
      .catch(() => setMe({ status: "signedOut" }));
  }, []);

  if (me.status === "loading") return <div className="center muted">Loading…</div>;
  if (me.status === "signedOut") return <Login error={error} />;
  return (
    <HubProvider>
      <Shell admin={me.admin} onLogout={() => setMe({ status: "signedOut" })} />
    </HubProvider>
  );
}

function Login({ error }: { error: string | null }) {
  return (
    <main className="center login-page">
      <div className="card login">
        <div className="logo" aria-hidden="true" />
        <h1>
          Lucid<b>Hub</b>
        </h1>
        <p className="muted">Run the events. Stack the prizes. The bot pays out (probably faster than you).</p>
        {error && <p className="error">{error}</p>}
        <a className="btn discord" href="/auth/discord">
          Sign in with Discord
        </a>
        <p className="fine">Admins only.</p>
      </div>
    </main>
  );
}

// icon: a 24×24 line-icon path, drawn with the current text color.
const NAV: { page: Page; href: string; label: string; icon: string }[] = [
  { page: "overview", href: "#/", label: "Overview", icon: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z" },
  { page: "events", href: "#/events", label: "Events", icon: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" },
  {
    page: "prizes",
    href: "#/prizes",
    label: "Prizes",
    icon: "M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z",
  },
  { page: "awards", href: "#/awards", label: "Deliveries", icon: "M22 2 11 13M22 2l-7 20-4-9-9-4z" },
  {
    page: "games",
    href: "#/games",
    label: "Games",
    icon: "M6 11h4M8 9v4M15 12h.01M18 10h.01M17.32 5H6.68a4 4 0 0 0-3.98 3.59L2 15a3 3 0 0 0 5.12 2.12L9 15h6l1.88 2.12A3 3 0 0 0 22 15l-.7-6.41A4 4 0 0 0 17.32 5z",
  },
  { page: "settings", href: "#/settings", label: "Settings", icon: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" },
];

function Shell({ admin, onLogout }: { admin: AdminInfo; onLogout: () => void }) {
  const route = useRoute();
  const { bot } = useHub();
  const active: Page = route.page === "event" || route.page === "new-event" ? "events" : route.page;

  const logout = async () => {
    await fetch("/auth/logout", { method: "POST" });
    onLogout();
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#/">
          <span className="orb" aria-hidden="true" />
          <span>
            Lucid<b>Hub</b>
          </span>
        </a>
        <nav>
          {NAV.map((n) => (
            <a key={n.page} href={n.href} className={active === n.page ? "active" : ""}>
              <span className="icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d={n.icon} />
                </svg>
              </span>
              <span>{n.label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`pill ${bot?.online ? "ok" : "bad"}`} title={bot?.tag ?? ""}>
            Bot {bot?.online ? "online" : "offline"}
          </span>
          <div className="me">
            <img src={admin.avatarUrl} alt="" width={26} height={26} />
            <span>{admin.username}</span>
            <button className="link" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="content">
        {route.page === "overview" && <OverviewPage />}
        {route.page === "events" && <EventsPage />}
        {route.page === "new-event" && <NewEventPage />}
        {route.page === "event" && route.id !== null && <EventPage id={route.id} />}
        {route.page === "prizes" && <PrizesPage />}
        {route.page === "awards" && <AwardsPage />}
        {route.page === "games" && <GamesPage />}
        {route.page === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}
