import { useEffect, useState } from "react";
import type { HubSettings } from "../shared/protocol.ts";
import { api, fmtTime, useApi } from "./api.ts";
import { ChannelPicker, PageHeader, useAction, useHub } from "./ui.tsx";

export function SettingsPage() {
  const { bot, reload } = useHub();
  const { data } = useApi<HubSettings>("/api/settings", 0);
  const [s, setS] = useState<HubSettings | null>(null);
  const { busy, run } = useAction();
  const audit = useApi<{ id: number; at: number; actor: string; action: string; detail: string | null }[]>("/api/audit", 20_000);

  useEffect(() => {
    if (data) setS(data);
  }, [data]);

  return (
    <>
      <PageHeader title="Settings" />

      <section className="card">
        <h3>Discord bot</h3>
        {!bot ? (
          <p className="muted">Checking…</p>
        ) : !bot.configured ? (
          <p className="warn">
            No bot token yet. Put <code>DISCORD_BOT_TOKEN</code> in the hub's <code>.env</code> and restart — see SETUP.md. Until then, prizes queue up and are sent once the bot is online.
          </p>
        ) : !bot.online ? (
          <p className="bad">The bot is offline. Check the token in .env and the hub's window for errors.</p>
        ) : (
          <p className="ok">
            Online as <strong>{bot.tag}</strong> in {bot.guilds.length} server{bot.guilds.length === 1 ? "" : "s"}.
          </p>
        )}
        {bot?.inviteUrl && (
          <p>
            <a className="btn ghost small-btn" href={bot.inviteUrl} target="_blank" rel="noreferrer">
              Invite the bot to a server ↗
            </a>
          </p>
        )}
      </section>

      {s && (
        <section className="card">
          <h3>Where the bot posts</h3>
          <div className="form-grid">
            <label>
              <span>Server</span>
              {bot?.guilds.length ? (
                <select value={s.guildId} onChange={(e) => setS({ ...s, guildId: e.target.value })}>
                  <option value="">{bot.guilds.length === 1 ? bot.guilds[0]!.name : "Pick a server…"}</option>
                  {bot.guilds.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={s.guildId} onChange={(e) => setS({ ...s, guildId: e.target.value.trim() })} placeholder="Server ID" />
              )}
            </label>
            <label>
              <span>Announce winners in (default)</span>
              <ChannelPicker value={s.announceChannelId} onChange={(v) => setS({ ...s, announceChannelId: v })} placeholder="Don't announce" />
            </label>
            <label>
              <span>Send alerts for me to</span>
              <ChannelPicker value={s.alertsChannelId} onChange={(v) => setS({ ...s, alertsChannelId: v })} placeholder="DM me instead" />
              <small className="muted">Low stock, failed DMs, a game going offline. Pick a private channel.</small>
            </label>
          </div>
          <div className="row end">
            {s.announceChannelId && (
              <button className="btn ghost" disabled={busy} onClick={() => run(() => api("/api/bot/test", { body: { channelId: s.announceChannelId } }), "Test message posted")}>
                Send test message
              </button>
            )}
            <button
              className="btn primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  setS(await api<HubSettings>("/api/settings", { method: "PUT", body: s }));
                  await reload();
                }, "Settings saved")
              }
            >
              Save
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <h3>Activity log</h3>
        <table className="table">
          <tbody>
            {audit.data?.map((a) => (
              <tr key={a.id}>
                <td className="muted small nowrap">{fmtTime(a.at)}</td>
                <td className="small">{a.actor}</td>
                <td className="small">
                  <strong>{a.action}</strong> {a.detail && <span className="muted">{a.detail}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
