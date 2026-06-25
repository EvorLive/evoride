import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  agentScrollback,
  agentSize,
  onAgentExit,
  onAgentOutput,
  resizeAgent,
  writeInput,
} from "../lib/tauri";
import { isTauri } from "../lib/bridge";

/// The PTY is shared between the desktop and any connected phone. Only the
/// desktop (native) drives its size — otherwise a phone's narrow xterm would
/// resize the shared PTY and reflow the desktop to mobile width. The remote
/// client renders into whatever size the desktop set.
function pushResize(id: string, rows: number, cols: number) {
  if (isTauri()) void resizeAgent(id, rows, cols);
}

/// Remote (phone) only: scale the real terminal render down so its full width
/// fits the pane. The pty is one size; we can't reflow a TUI, so we zoom.
function fitHostZoom(host: HTMLElement) {
  const xt = host.querySelector(".xterm") as HTMLElement | null;
  const pane = host.parentElement;
  if (!xt || !pane) return;
  host.style.zoom = "1"; // reset to measure the natural render width
  const w = xt.offsetWidth;
  if (w < 5) return;
  host.style.zoom = `${Math.min(1, (pane.clientWidth - 2) / w)}`;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const DARK_THEME = {
  // Opaque and matched to the dark pane (--bg) so the terminal is seamless and
  // text keeps full contrast — a translucent bg composites into a washed-out
  // grey when the pane underneath is the other mode.
  background: "#090b11",
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

// Light theme so the terminal matches the IDE when it's in light mode — ANSI
// colors darkened to read on a white background.
const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#10151c",
  cursor: "#0270b0",
  cursorAccent: "#ffffff",
  selectionBackground: "#bcdcf6",
  black: "#1b1f26",
  red: "#c01540",
  green: "#1f7a30",
  yellow: "#825400",
  blue: "#1361bf",
  magenta: "#882596",
  cyan: "#0a6e80",
  white: "#3c434d",
  brightBlack: "#5e6672",
  brightRed: "#cf3a08",
  brightGreen: "#1f7a32",
  brightYellow: "#6c4a00",
  brightBlue: "#1357a8",
  brightMagenta: "#76238a",
  brightCyan: "#0a6173",
  brightWhite: "#10151c",
};

const themeFor = (mode: "light" | "dark") => (mode === "light" ? LIGHT_THEME : DARK_THEME);

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
  mode,
  onUrl,
  onIssue,
  onInput,
  onTitle,
}: {
  id: string;
  active: boolean;
  /** Resolved IDE color mode so the terminal matches it. */
  mode: "light" | "dark";
  onUrl?: (url: string) => void;
  /** Fires (with recent output) when a failure signature appears live. */
  onIssue?: (context: string) => void;
  /** Fires when the user types into this terminal (to clear "needs you"). */
  onInput?: () => void;
  /** Fires when the program sets the terminal title (OSC 0/2) — e.g. Claude
   *  updating its task title — so the UI can reflect it live. */
  onTitle?: (title: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onUrlRef = useRef(onUrl);
  onUrlRef.current = onUrl;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const onIssueRef = useRef(onIssue);
  onIssueRef.current = onIssue;
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;

  // Right-click context menu (viewport coords + whether there's a selection).
  const [menu, setMenu] = useState<{ x: number; y: number; hasSel: boolean } | null>(null);

  const doCopy = () => {
    const t = termRef.current;
    if (t?.hasSelection()) navigator.clipboard?.writeText(t.getSelection()).catch(() => {});
    setMenu(null);
  };
  const doPaste = () => {
    navigator.clipboard
      ?.readText()
      .then((t) => t && writeInput(id, t))
      .catch(() => {});
    setMenu(null);
  };
  const doSelectAll = () => {
    termRef.current?.selectAll();
    setMenu(null);
  };
  const doClear = () => {
    termRef.current?.clear();
    termRef.current?.focus();
    setMenu(null);
  };

  // Dismiss the menu on any outside click, scroll, Escape, or window blur.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    // `click` (not mousedown) so a menu item's own onClick fires first.
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.15,
      // Force readable contrast: xterm dynamically lifts any low-contrast text
      // (dim/faint output, agent palette) to meet this ratio against the bg —
      // fixes washed-out greys, especially on the white light theme.
      minimumContrastRatio: 4.5,
      theme: themeFor(mode),
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

    // Live title: xterm parses OSC 0/2 title sequences for us. Claude (and other
    // agents) set this as they work — surface it so the tab/toolbar update at once.
    term.onTitleChange((t) => {
      const title = t.trim();
      if (title) onTitleRef.current?.(title);
    });

    // Copy / paste. ⌘C (mac) or Ctrl+Shift+C copies the selection; ⌘V (mac) or
    // Ctrl+Shift+V pastes into the pty. Returning false stops xterm/the pty from
    // also seeing the key (so ⌘C doesn't send ^C).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const k = e.key.toLowerCase();
      const copyCombo = (e.metaKey && k === "c") || (e.ctrlKey && e.shiftKey && k === "c");
      const pasteCombo = (e.metaKey && k === "v") || (e.ctrlKey && e.shiftKey && k === "v");
      if (copyCombo && term.hasSelection()) {
        navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      if (pasteCombo) {
        navigator.clipboard
          ?.readText()
          .then((t) => t && writeInput(id, t))
          .catch(() => {});
        return false;
      }
      return true;
    });

    // Right-click opens a context menu (Copy / Paste / Select All / Clear). The
    // global context menu is suppressed elsewhere, so this is the one place it
    // appears. Anchor it to the cursor and note whether there's a selection.
    const onContext = (ev: MouseEvent) => {
      ev.preventDefault();
      setMenu({ x: ev.clientX, y: ev.clientY, hasSel: term.hasSelection() });
    };
    host.addEventListener("contextmenu", onContext);

    // On a phone (remote browser) we don't own the pty: match its size so the
    // rendering is identical to the desktop, and let the pane scroll/zoom. On
    // desktop we fit the pty to the tile.
    const remote = !isTauri();

    // Size the xterm to the shared pty (remote viewer only).
    const matchPty = () =>
      agentSize(id)
        .then((sz) => {
          if (sz && !disposed) {
            try {
              term.resize(sz[1], sz[0]); // [rows, cols] -> resize(cols, rows)
            } catch {
              /* detached */
            }
          }
        })
        .catch(() => {});

    // Remote (phone): the pty is one size (the desktop's). We can't reflow a
    // full-screen TUI, so scale the real render down to fit the phone's width —
    // the whole terminal is visible, pinch to zoom for detail, scroll for height.
    const fitRemote = () => fitHostZoom(host);

    // Only fit/resize when the tile is actually visible with real width —
    // fitting while hidden (display:none) would size the pty to ~1 column.
    const doFit = () => {
      if (remote) {
        fitRemote();
        return; // remote never resizes the shared pty
      }
      if (host.offsetWidth < 30 || host.offsetHeight < 20) return;
      try {
        fit.fit();
        if (term.cols > 1) pushResize(id, term.rows, term.cols);
      } catch {
        /* detached */
      }
    };
    doFit();

    // Desktop: refit the pty on tile resize. Remote: re-scale on viewport change
    // (observe the pane, not the host — zooming the host would loop).
    const ro = new ResizeObserver(doFit);
    ro.observe(remote ? host.parentElement ?? host : host);

    const decoder = new TextDecoder();
    let scanBuf = "";
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (u: () => void) => (disposed ? u() : unlisteners.push(u));

    // Restore prior context from the backend scrollback (the tile may have been
    // discarded while running), THEN attach to live output. On a phone, match
    // the pty size FIRST so the restored buffer lays out at the right width.
    (remote ? matchPty() : Promise.resolve())
      .then(() => agentScrollback(id))
      .then((b64) => {
        if (!disposed && b64) term.write(b64ToBytes(b64));
        if (remote && !disposed) requestAnimationFrame(fitRemote);
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
      host.removeEventListener("contextmenu", onContext);
      unlisteners.forEach((u) => u());
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Rebuild on `mode` change too: xterm's runtime theme update doesn't reliably
    // repaint the existing buffer in this webview, so we recreate with the correct
    // theme at construction (scrollback is restored from the backend above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, mode]);

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
        if (isTauri()) {
          fit.fit();
          if (term.cols > 1) pushResize(id, term.rows, term.cols);
        } else {
          // Remote: re-match the shared pty in case the desktop resized it,
          // then re-scale to fit the phone width.
          void agentSize(id).then((sz) => {
            if (sz) {
              try {
                term.resize(sz[1], sz[0]);
              } catch {
                /* detached */
              }
            }
            requestAnimationFrame(() => fitHostZoom(host));
          });
        }
        term.focus();
      } catch {
        /* detached */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [active, id]);

  // Host stays transparent over the pane (var(--bg)); the terminal paints its own
  // opaque background matched to the pane, so the padding/fit gap blends in.
  return (
    <>
      <div ref={hostRef} className="term-host" />
      {menu && (
        <div
          className="term-ctx"
          style={{ left: menu.x, top: menu.y }}
          // Stop the window `click`/`contextmenu` closers from firing for clicks
          // landing inside the menu itself.
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          role="menu"
        >
          <button className="term-ctx-item" role="menuitem" disabled={!menu.hasSel} onClick={doCopy}>
            <span>Copy</span>
            <span className="term-ctx-key">⌘C</span>
          </button>
          <button className="term-ctx-item" role="menuitem" onClick={doPaste}>
            <span>Paste</span>
            <span className="term-ctx-key">⌘V</span>
          </button>
          <button className="term-ctx-item" role="menuitem" onClick={doSelectAll}>
            <span>Select All</span>
            <span className="term-ctx-key">⌘A</span>
          </button>
          <div className="term-ctx-sep" />
          <button className="term-ctx-item" role="menuitem" onClick={doClear}>
            <span>Clear</span>
          </button>
        </div>
      )}
    </>
  );
}
