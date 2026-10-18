import { useEffect, useState } from "react";

// Hash routes: #/  ·  #/events  ·  #/events/new  ·  #/events/12  ·  #/prizes  ·  #/awards  ·  #/games  ·  #/settings
export type Page = "overview" | "events" | "event" | "new-event" | "prizes" | "awards" | "games" | "settings";
export interface Route {
  page: Page;
  id: number | null;
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  if (path === "/events/new") return { page: "new-event", id: null };
  const ev = path.match(/^\/events\/(\d+)/);
  if (ev) return { page: "event", id: Number(ev[1]) };
  const page = path.slice(1).split("/")[0] as Page;
  return { page: ["events", "prizes", "awards", "games", "settings"].includes(page) ? page : "overview", id: null };
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
