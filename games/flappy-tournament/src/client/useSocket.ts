import { useEffect, useRef, useState } from "react";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

export type SocketStatus = "connecting" | "open" | "closed";

/** Keeps a WebSocket to the server open, reconnecting with backoff (e.g. after the host restarts). */
export function useSocket(onMessage: (msg: ServerMessage) => void, onOpen?: () => void) {
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const socketRef = useRef<WebSocket | null>(null);
  const handler = useRef(onMessage);
  handler.current = onMessage;
  const opened = useRef(onOpen);
  opened.current = onOpen;

  useEffect(() => {
    let stopped = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;

    const connect = () => {
      setStatus("connecting");
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      socketRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setStatus("open");
        opened.current?.();
      };
      ws.onmessage = (e) => handler.current(JSON.parse(e.data) as ServerMessage);
      ws.onclose = (e) => {
        setStatus("closed");
        if (stopped || e.code === 4001) return; // 4001 = not signed in; reconnecting won't help
        timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15_000));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socketRef.current?.close();
    };
  }, []);

  const send = (msg: ClientMessage) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(msg));
  };
  return { status, send };
}
