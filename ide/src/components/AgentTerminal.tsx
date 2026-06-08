import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  agentScrollback,
  onAgentExit,
  onAgentOutput,
  resizeAgent,
  writeInput,
} from "../lib/tauri";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const THEME = {
  background: "#0b0d12",
  foreground: "#e6e8ee",
  cursor: "#38bdf8",
  cursorAccent: "#0b0d12",
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
};

// Strip ANSI/control bytes so URL sniffing doesn't capture escape codes.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]/g;
// Match only the ORIGIN (scheme://host:port) — open the dev-server root, not
// whatever long API path the agent happened to print.
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w.-]+)(?::\d+)?/g;

// Failure signatures (mirrors eterm-core::has_error_signature) for the live
// "Fix this issue" button.
const ERROR_SIGS = [
  "error[E",
  "panic",
  "Traceback (most recent call last)",
  "npm ERR!",
  "fatal:",
  "Error:",
  "error:",
  "Exception",
  "command not found",
  "No such file",
  "cannot find",
  "Cannot find",
  "Segmentation fault",
  "Build failed",
  "compilation failed",
  "FAILED",
];
const hasErrorSig = (s: string) => ERROR_SIGS.some((sig) => s.includes(sig));

// A live, interactive terminal for one local agent pty.
export default function AgentTerminal({
  id,
  active,
  onUrl,
  onIssue,
  onInput,
}: {
  id: string;
  active: boolean;
  onUrl?: (url: string) => void;
  /** Fires (with recent output) when a failure signature appears live. */
  onIssue?: (context: string) => void;
  /** Fires when the user types into this terminal (to clear "needs you"). */
  onInput?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onUrlRef = useRef(onUrl);
  onUrlRef.current = onUrl;
  const onIssueRef = useRef(onIssue);
  onIssueRef.current = onIssue;
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.15,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    term.onData((data) => {
      onInputRef.current?.();
      void writeInput(id, data);
    });

    // Only fit/resize when the tile is actually visible with real width —
    // fitting while hidden (display:none) would size the pty to ~1 column.
    const doFit = () => {
      if (host.offsetWidth < 30 || host.offsetHeight < 20) return;
      try {
        fit.fit();
        if (term.cols > 1) void resizeAgent(id, term.rows, term.cols);
      } catch {
        /* detached */
      }
    };
    doFit();

    const ro = new ResizeObserver(doFit);
    ro.observe(host);

    const decoder = new TextDecoder();
    let scanBuf = "";
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (u: () => void) => (disposed ? u() : unlisteners.push(u));

    // Restore prior context from the backend scrollback (the tile may have been
    // discarded while running), THEN attach to live output.
    agentScrollback(id)
      .then((b64) => {
        if (!disposed && b64) term.write(b64ToBytes(b64));
      })
      .catch(() => {})
      .finally(() => {
        if (disposed) return;
        onAgentOutput(id, (bytes) => {
          term.write(bytes);
          if (!onUrlRef.current && !onIssueRef.current) return;
          const clean = decoder
            .decode(bytes, { stream: true })
            .replace(ANSI_RE, "")
            .replace(/[\x00-\x1f]/g, " ");
          scanBuf = (scanBuf + clean).slice(-6000);
          if (onUrlRef.current) {
            const matches = scanBuf.match(URL_RE);
            if (matches && matches.length) {
              onUrlRef.current(matches[matches.length - 1].replace(/[.,]+$/, ""));
            }
          }
          // Fire only when THIS chunk introduced an error line (not every chunk).
          if (onIssueRef.current && hasErrorSig(clean)) {
            onIssueRef.current(scanBuf);
          }
        }).then(track);
        onAgentExit(id, () => {
          term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
        }).then(track);
      });

    return () => {
      disposed = true;
      ro.disconnect();
      unlisteners.forEach((u) => u());
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // When this tile becomes active (shown), it finally has width — refit so the
  // pty matches the real column count.
  useEffect(() => {
    if (!active) return;
    const fit = fitRef.current;
    const term = termRef.current;
    const host = hostRef.current;
    if (!fit || !term || !host) return;
    const raf = requestAnimationFrame(() => {
      if (host.offsetWidth < 30) return;
      try {
        fit.fit();
        if (term.cols > 1) void resizeAgent(id, term.rows, term.cols);
        term.focus();
      } catch {
        /* detached */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [active, id]);

  return <div ref={hostRef} className="term-host" />;
}
