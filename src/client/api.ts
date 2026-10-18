import { useCallback, useEffect, useState } from "react";

export class ApiError extends Error {}

/** JSON request to the hub. Throws ApiError with the server's message on failure. */
export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401) {
    location.reload();
    throw new ApiError("Signed out");
  }
  if (!res.ok) throw new ApiError((data as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Loads a resource and reloads it every `refreshMs` (default 15 s) so the dashboard stays live. */
export function useApi<T>(path: string | null, refreshMs = 15_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    void reload();
    if (!refreshMs) return;
    const t = setInterval(() => void reload(), refreshMs);
    return () => clearInterval(t);
  }, [reload, refreshMs]);
  return { data, error, reload };
}

export const fmtTime = (t: number | null | undefined) =>
  t ? new Date(t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

export function fmtAgo(t: number | null | undefined) {
  if (!t) return "—";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtTime(t);
}

export const placeLabel = (from: number, to: number) => (from === to ? ordinal(from) : `${ordinal(from)}–${ordinal(to)}`);

export function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}
