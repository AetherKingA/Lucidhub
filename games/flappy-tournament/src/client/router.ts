import { useEffect, useState } from "react";

// Hash routes: #/  ·  #/t/12  ·  #/t/12/watch (spectator view, linked from LucidHub's "Watch live")
export type Route = { page: "lobby" } | { page: "tournament"; tournamentId: number; watch: boolean };

export function parseRoute(hash: string): Route {
  const m = hash.replace(/^#/, "").match(/^\/t\/(\d+)(\/watch)?/);
  if (!m) return { page: "lobby" };
  return { page: "tournament", tournamentId: Number(m[1]), watch: Boolean(m[2]) };
}

const RETURN_KEY = "returnTo";

/** Remembers the page someone was trying to open (e.g. a "Watch live" link) while they sign in. */
export function rememberPage() {
  try {
    if (location.hash.length > 2) sessionStorage.setItem(RETURN_KEY, location.hash);
  } catch {
    /* private mode */
  }
}

/** After signing in, goes back to that page (sign-in always lands on the lobby). */
export function restorePage() {
  try {
    const hash = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    if (hash && /^#\/t\/\d+/.test(hash) && location.hash.length <= 2) location.hash = hash;
  } catch {
    /* private mode */
  }
}

export function navigate(path: string) {
  location.hash = path;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
