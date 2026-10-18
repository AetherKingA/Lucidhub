import { useEffect, useRef, useState } from "react";
import type { Equity } from "../shared/equity.ts";
import type { EquityRequest } from "./equityWorker.ts";

let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, (e: Equity | null) => void>();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./equityWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; result: Equity | null }>) => {
      waiting.get(e.data.id)?.(e.data.result);
      waiting.delete(e.data.id);
    };
  }
  return worker;
}

/**
 * Your chance to win with these cards against `opponents` random hands. Recomputed when the cards
 * or the number of opponents change; null while not in a hand.
 */
export function useEquity(hole: string[] | null, board: string[], opponents: number): Equity | null {
  const [equity, setEquity] = useState<Equity | null>(null);
  const latest = useRef(0);
  const key = hole && !hole.includes("??") && opponents > 0 ? `${hole.join("")}|${board.join("")}|${opponents}` : "";

  useEffect(() => {
    if (!key) {
      setEquity(null);
      return;
    }
    let w: Worker;
    try {
      w = getWorker();
    } catch {
      return; // no workers: just don't show it
    }
    const id = ++nextId;
    latest.current = id;
    setEquity(null); // don't show the last hand's number while this one is worked out
    waiting.set(id, (result) => {
      if (latest.current === id) setEquity(result);
    });
    w.postMessage({ id, hole: hole!, board, opponents } satisfies EquityRequest);
  }, [key]);

  return key ? equity : null;
}
