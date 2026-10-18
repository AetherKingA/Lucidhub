// Runs the win-chance simulation off the main thread, so the table never stutters.

import { estimateEquity } from "../shared/equity.ts";

export interface EquityRequest {
  id: number;
  hole: string[];
  board: string[];
  opponents: number;
}

self.onmessage = (e: MessageEvent<EquityRequest>) => {
  const { id, hole, board, opponents } = e.data;
  const result = estimateEquity(hole, board, opponents, 4000);
  (self as unknown as Worker).postMessage({ id, result });
};
