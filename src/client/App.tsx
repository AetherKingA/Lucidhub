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

const NAV: { page: Page; href: string; label: string; icon: string }[] = [
  { page: "overview", href: "#/", label: "Overview", icon: "◎" },
  { page: "events", href: "#/events", label: "Events", icon: "▦" },
  { page: "prizes", href: "#/prizes", label: "Prizes", icon: "◆" },
  { page: "awards", href: "#/awards", label: "Deliveries", icon: "✉" },
  { page: "games", href: "#/games", label: "Games", icon: "♞" },
  { page: "settings", href: "#/settings", label: "Settings", icon: "⚙" },
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
              <span className="icon">{n.icon}</span>
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
