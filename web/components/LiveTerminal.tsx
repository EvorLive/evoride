"use client";

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { viewUrl } from "@/lib/config";
import {
  parseControl,
  asAgentStatus,
  type AgentStatus,
  type PermissionRequest,
  type SessionMeta,
  type TimelineMarker,
} from "@/lib/protocol";

type Props = {
  sessionId: string;
  /** When set, keystrokes are forwarded via this callback (control mode). */
  onInput?: (data: string) => void;
  onMeta?: (m: SessionMeta) => void;
  onAgent?: (a: AgentStatus) => void;
  onMarker?: (m: TimelineMarker) => void;
  onPermission?: (p: PermissionRequest | null) => void;
  onConnection?: (s: "connecting" | "live" | "ended" | "closed") => void;
};

// Read-only mirror of a remote terminal. Renders the relay's binary output
// stream into xterm and lifts control-frame data (meta/agent/markers) upward.
export default function LiveTerminal({
  sessionId,
  onInput,
  onMeta,
  onAgent,
  onMarker,
  onPermission,
  onConnection,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Latest callbacks via refs so the terminal isn't re-created on prop changes.
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;
  const onPermissionRef = useRef(onPermission);
  onPermissionRef.current = onPermission;

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      // Stdin stays enabled to capture keystrokes; they're only forwarded when
      // a control channel is active (onInput set), otherwise dropped.
      disableStdin: false,
      allowProposedApi: true,
      fontFamily:
        'var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      // Full 16-color ANSI palette so app colors render correctly with proper
      // contrast on the dark background (the default palette is washed out).
      theme: {
        // Matches --color-bg so the terminal blends into the app shell.
        background: "#090b11",
        foreground: "#e6e8ee",
        cursor: "#38bdf8",
        cursorAccent: "#090b11",
        selectionBackground: "#334155",
        black: "#1e222a",
        red: "#ff6b6b",
        green: "#5ef38c",
        yellow: "#ffd866",
        blue: "#6db3ff",
        magenta: "#d291ff",
        cyan: "#5ef0e6",
        white: "#d7dae0",
        brightBlack: "#5b6270",
        brightRed: "#ff8787",
        brightGreen: "#85ffac",
        brightYellow: "#ffe79e",
        brightBlue: "#9ecbff",
        brightMagenta: "#e0b4ff",
        brightCyan: "#9bf6ee",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    fit.fit();

    // Forward keystrokes only while a control channel is wired up.
    term.onData((data) => onInputRef.current?.(data));

    // Once the producer's real size is known we lock to it for faithful
    // rendering; until then we fit to the container.
    let sizeLocked = false;
    const onResize = () => {
      if (sizeLocked) return;
      try {
        fit.fit();
      } catch {
        /* host detached */
      }
    };
    window.addEventListener("resize", onResize);

    onConnection?.("connecting");
    const ws = new WebSocket(viewUrl(sessionId));
    ws.binaryType = "arraybuffer";

    ws.onopen = () => onConnection?.("live");
    ws.onclose = () => onConnection?.("closed");
    ws.onerror = () => onConnection?.("closed");
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const ctrl = parseControl(ev.data);
        if (!ctrl) return;
        if (ctrl.type === "start") {
          // Render at the producer's exact dimensions.
          if (ctrl.cols > 0 && ctrl.rows > 0) {
            term.resize(ctrl.cols, ctrl.rows);
            sizeLocked = true;
          }
          onMeta?.(ctrl);
        } else if (ctrl.type === "resize") {
          if (ctrl.cols > 0 && ctrl.rows > 0) {
            term.resize(ctrl.cols, ctrl.rows);
            sizeLocked = true;
          }
        } else if (ctrl.type === "agent") {
          const a = asAgentStatus(ctrl);
          if (a) onAgent?.(a);
        } else if (ctrl.type === "marker") {
          onMarker?.({ label: ctrl.label, t: ctrl.t });
        } else if (ctrl.type === "permission_request") {
          onPermissionRef.current?.({
            request_id: ctrl.request_id,
            prompt: ctrl.prompt,
            options: ctrl.options,
          });
        } else if (ctrl.type === "end") {
          onPermissionRef.current?.(null);
          onConnection?.("ended");
        }
      } else {
        term.write(new Uint8Array(ev.data as ArrayBuffer));
      }
    };

    return () => {
      window.removeEventListener("resize", onResize);
      ws.close();
      term.dispose();
    };
    // Re-init only when the session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return (
    <div className="h-full w-full overflow-hidden rounded-lg border border-border bg-bg p-2">
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
