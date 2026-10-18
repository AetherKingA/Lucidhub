import { useState } from "react";
import type { Award } from "../shared/protocol.ts";
import { useApi } from "./api.ts";
import { AwardTable } from "./Events.tsx";
import { Empty, PageHeader } from "./ui.tsx";

const FILTERS: [string, string][] = [
  ["", "All"],
  ["dm_failed", "DM failed"],
  ["waiting_stock", "Waiting for codes"],
  ["pending", "Sending"],
  ["sent", "Sent"],
  ["manual", "By hand"],
  ["cancelled", "Cancelled"],
];

export function AwardsPage() {
  const [status, setStatus] = useState("");
  const { data, reload } = useApi<Award[]>(`/api/awards${status ? `?status=${status}` : ""}`, 10_000);

  return (
    <>
      <PageHeader title="Deliveries" sub="Every prize the bot has handed out. Winners can always see theirs with /prizes in Discord." />
      <div className="tabs">
        {FILTERS.map(([v, label]) => (
          <button key={v} className={status === v ? "active" : ""} onClick={() => setStatus(v)}>
            {label}
          </button>
        ))}
      </div>
      <section className="card">
        {!data ? <p className="muted">Loading…</p> : data.length === 0 ? <Empty>Nothing here.</Empty> : <AwardTable awards={data} onChange={reload} />}
      </section>
    </>
  );
}
