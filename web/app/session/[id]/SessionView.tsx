"use client";

import { useCallback, useEffect, useState } from "react";
import LiveTerminal from "@/components/LiveTerminal";
import StatusPanel from "@/components/StatusPanel";
import ControlBar from "@/components/ControlBar";
import { useControlChannel } from "@/lib/useControlChannel";
import type {
  AgentStatus,
  PermissionRequest,
  SessionMeta,
  TimelineMarker,
} from "@/lib/protocol";

type Conn = "connecting" | "live" | "ended" | "closed";

// Owns the shared session state that the terminal feeds and the panel renders,
// plus the token-gated control channel for sending input back to the terminal.
export default function SessionView({ sessionId }: { sessionId: string }) {
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [markers, setMarkers] = useState<TimelineMarker[]>([]);
  const [conn, setConn] = useState<Conn>("connecting");
  const [permission, setPermission] = useState<PermissionRequest | null>(null);

  // Control token survives reloads: persisted per-session in localStorage so a
  // refresh transparently reconnects the control channel instead of dropping to
  // view-only and forcing the user to re-paste the token.
  const tokenKey = `eterm:control-token:${sessionId}`;
  // Lazily seed from localStorage. Safe against hydration mismatch: the control
  // channel always starts "off" until its effect connects, so the first render
  // is identical whether or not a token is present.
  const [token, setTokenState] = useState<string | null>(() =>
    typeof window === "undefined"
      ? null
      : window.localStorage.getItem(tokenKey),
  );

  const setToken = useCallback(
    (next: string | null) => {
      setTokenState(next);
      if (next) window.localStorage.setItem(tokenKey, next);
      else window.localStorage.removeItem(tokenKey);
    },
    [tokenKey],
  );

  const { state: controlState, sendInput } = useControlChannel(sessionId, token);
  const controlling = controlState === "open";

  // A rejected token is stale — drop it so a refresh doesn't keep retrying it.
  // Syncing React state off an external WS event (the channel's "denied"
  // transition), so the set-state-in-effect guidance doesn't apply here.
  useEffect(() => {
    if (controlState === "denied") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTokenState(null);
      window.localStorage.removeItem(tokenKey);
    }
  }, [controlState, tokenKey]);

  const onMarker = useCallback((m: TimelineMarker) => {
    setMarkers((prev) => [...prev, m].slice(-100));
  }, []);

  const reply = useCallback(
    (data: string) => {
      sendInput(data);
      // A reply resolves the current prompt optimistically.
      setPermission(null);
    },
    [sendInput],
  );

  return (
    <div className="flex flex-1 overflow-hidden">
      <main className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <header className="flex items-baseline justify-between gap-3">
          <h1 className="truncate text-sm font-medium text-fg" title={meta?.title}>
            {meta?.title ?? "Connecting…"}
          </h1>
          <span className="shrink-0 font-mono text-xs text-fg-subtle">
            {sessionId}
          </span>
        </header>

        <ControlBar
          controlState={controlState}
          onSetToken={setToken}
          onReply={reply}
          permission={permission}
          waiting={agent?.state === "waiting_input"}
        />

        <div className="min-h-0 flex-1">
          <LiveTerminal
            sessionId={sessionId}
            onInput={controlling ? sendInput : undefined}
            onMeta={setMeta}
            onAgent={setAgent}
            onMarker={onMarker}
            onPermission={setPermission}
            onConnection={setConn}
          />
        </div>
      </main>
      <StatusPanel meta={meta} agent={agent} markers={markers} conn={conn} />
    </div>
  );
}
