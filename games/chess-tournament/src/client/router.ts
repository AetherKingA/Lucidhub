import { useEffect, useState } from "react";

// Hash routes: #/  ·  #/t/12  ·  #/t/12/table/3
export type Route =
  | { page: "lobby"; tournamentId: null; tableId: null }
  | { page: "tournament"; tournamentId: number; tableId: null }
  | { page: "table"; tournamentId: number; tableId: number };

export function parseRoute(hash: string): Route {
  const m = hash.replace(/^#/, "").match(/^\/t\/(\d+)(?:\/table\/(\d+))?/);
  if (!m) return { page: "lobby", tournamentId: null, tableId: null };
  if (m[2]) return { page: "table", tournamentId: Number(m[1]), tableId: Number(m[2]) };
  return { page: "tournament", tournamentId: Number(m[1]), tableId: null };
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
