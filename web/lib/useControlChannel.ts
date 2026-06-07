"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { controlUrl } from "./config";

export type ControlState = "off" | "connecting" | "open" | "denied" | "closed";

// Opens the token-gated /control socket and exposes a sendInput(). Keystrokes
// and button replies both funnel through here as ViewerMsg "input" frames.
export function useControlChannel(sessionId: string, token: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<ControlState>("off");

  useEffect(() => {
    if (!token) {
      setState("off");
      return;
    }
    setState("connecting");
    const ws = new WebSocket(controlUrl(sessionId, token));
    wsRef.current = ws;

    ws.onopen = () => setState("open");
    ws.onclose = (ev) => {
      // 4003 = relay rejected the token.
      setState(ev.code === 4003 ? "denied" : "closed");
      if (wsRef.current === ws) wsRef.current = null;
    };
    ws.onerror = () => setState((s) => (s === "open" ? "closed" : s));

    return () => {
      ws.close();
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [sessionId, token]);

  const sendInput = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }));
    }
  }, []);

  return { state, sendInput };
}
