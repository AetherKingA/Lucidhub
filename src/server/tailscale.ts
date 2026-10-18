// Tailscale Funnel: how players on the internet reach a game running on this PC. LucidHub opens the
// Funnel when it starts a public game and closes it when the game stops.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const FUNNEL_PORTS = [443, 8443, 10000] as const;
const TIMEOUT_MS = 20_000;

export interface TailscaleInfo {
  installed: boolean;
  /** Logged in and connected. */
  running: boolean;
  /** e.g. desktop-78mbs6o.tail1234.ts.net */
  dnsName: string | null;
  canFunnel: boolean;
}

export type FunnelResult =
  | { ok: true; url: string }
  /** url: the public address it will have once Funnel works, when Tailscale knows it. */
  | { ok: false; reason: string; approveUrl?: string; url?: string };

/** Tailscale's default install folder on Windows, else whatever is on PATH. */
function exePath(): string {
  if (process.platform === "win32") {
    const p = join(process.env.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe");
    if (existsSync(p)) return p;
  }
  return "tailscale";
}

function run(args: string[], timeoutMs = TIMEOUT_MS): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  const exe = exePath();
  return new Promise((resolve) => {
    const child = execFile(exe, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`.trim();
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      if (e?.code === "ENOENT") return resolve({ code: null, output: "Tailscale is not installed", timedOut: false });
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, output, timedOut: Boolean(e?.killed) });
    });
    child.stdin?.end();
  });
}

export async function tailscaleInfo(): Promise<TailscaleInfo> {
  const r = await run(["status", "--json"], 8000);
  if (r.output === "Tailscale is not installed") return { installed: false, running: false, dnsName: null, canFunnel: false };
  try {
    const j = JSON.parse(r.output.slice(r.output.indexOf("{"))) as {
      BackendState?: string;
      Self?: { DNSName?: string; Capabilities?: string[]; CapMap?: Record<string, unknown> };
    };
    const caps = [...(j.Self?.Capabilities ?? []), ...Object.keys(j.Self?.CapMap ?? {})];
    return {
      installed: true,
      running: j.BackendState === "Running",
      dnsName: j.Self?.DNSName?.replace(/\.$/, "") || null,
      canFunnel: caps.includes("funnel"),
    };
  } catch {
    return { installed: true, running: false, dnsName: null, canFunnel: false };
  }
}

export const funnelUrl = (dnsName: string, httpsPort: number) => `https://${dnsName}${httpsPort === 443 ? "" : `:${httpsPort}`}`;

/** Points https://<this PC>.ts.net[:httpsPort] at the game's local port. */
export async function openFunnel(localPort: number, httpsPort: number): Promise<FunnelResult> {
  const info = await tailscaleInfo();
  if (!info.installed) return { ok: false, reason: "Tailscale isn't installed, so only this PC can reach the game. Install it from tailscale.com/download." };
  if (!info.running || !info.dnsName) return { ok: false, reason: "Tailscale isn't connected. Open Tailscale and sign in." };
  const url = funnelUrl(info.dnsName, httpsPort);
  const r = await run(["funnel", "--bg", "--yes", `--https=${httpsPort}`, String(localPort)]);
  // First use: Tailscale asks you to approve Funnel/HTTPS in the browser and prints a link.
  const link = r.output.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
  if (link) return { ok: false, reason: "Tailscale needs you to approve Funnel for this PC (one time).", approveUrl: link, url };
  if (r.code !== 0 || r.timedOut)
    return { ok: false, reason: `Tailscale Funnel didn't start: ${r.timedOut ? "timed out" : r.output.split("\n")[0] || `exit code ${r.code}`}`, url };
  return { ok: true, url };
}

export async function closeFunnel(httpsPort: number) {
  await run(["funnel", `--https=${httpsPort}`, "off"], 8000);
}
