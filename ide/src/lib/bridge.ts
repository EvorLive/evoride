// Transport bridge: lets the EXACT SAME React app run two ways.
//
//  * Desktop (Tauri): `invoke`/`listen` go through native in-process IPC.
//  * Remote (browser → evor-daemon): the same calls become HTTP `POST /rpc`
//    and a single `WS /events` subscription, authed with a session token.
//
// `tauri.ts` imports `invoke`/`listen`/`pickFolder`/`confirmDialog`/`appVersion`
// from here instead of straight from `@tauri-apps/*`, so ~100 call sites are
// transport-agnostic and nothing else in the UI has to change.
//
// Mode is decided once at load: if the Tauri runtime globals are present we're
// the desktop app; otherwise we're a browser pointed at the daemon.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as tauriOpen, confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow as tauriGetCurrentWindow } from "@tauri-apps/api/window";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

export type { UnlistenFn };

/** True when running inside the Tauri desktop shell (native IPC available). */
export const isTauri = (): boolean =>
  typeof window !== "undefined" &&
  // Tauri v2 injects these internals into the webview.
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

// ---------------------------------------------------------------------------
// Remote (browser) session token
// ---------------------------------------------------------------------------

const TOKEN_KEY = "evor.daemon.token";

/** Capture a token handed over via the quick-link fragment (`#t=...`). */
function captureHashToken(): void {
  if (typeof location === "undefined") return;
  const m = location.hash.match(/[#&]t=([0-9a-fA-F]+)/);
  if (m) {
    localStorage.setItem(TOKEN_KEY, m[1]);
    // Strip it from the address bar so it isn't shoulder-surfed or bookmarked.
    history.replaceState(null, "", location.pathname + location.search);
  }
}

let tokenPromise: Promise<string> | null = null;

/** Resolve the session token: from the fragment, from localStorage, or by
 *  prompting for the session code and exchanging it at `/auth`. Cached. */
function ensureToken(): Promise<string> {
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    captureHashToken();
    let token = localStorage.getItem(TOKEN_KEY) ?? "";
    // Validate (or obtain) by round-tripping the code through /auth.
    for (;;) {
      if (token) {
        const ok = await validateToken(token);
        if (ok) return token;
        localStorage.removeItem(TOKEN_KEY);
      }
      const code = window.prompt("Enter the EvorIDE session code from the daemon:");
      if (!code) {
        // User dismissed — back off briefly so we don't busy-loop on every call.
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      token = code.trim();
      localStorage.setItem(TOKEN_KEY, token);
    }
  })();
  return tokenPromise;
}

async function validateToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(`/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cloud transport (browser → evor.dev relay → desktop), end-to-end encrypted.
//
// One WebSocket carries both RPC (req/res) and the live event stream as OPAQUE
// XChaCha20-Poly1305 frames. The relay only sees ciphertext; the key is shared
// out-of-band via the pairing QR. Mirrors the desktop `cloud.rs` framing:
//   req: {t:"req",id,cmd,args}  res: {t:"res",id,ok,data|error}  ev: {t:"ev",topic,payload}
// ---------------------------------------------------------------------------

const CLOUD_KEY = "evor.cloud";
interface CloudCfg {
  /** Relay origin (defaults to the page origin when served by evor.dev). */
  relay?: string;
  device: string;
  /** 32-byte E2E key, hex. */
  key: string;
}

function hexToBytes(h: string): Uint8Array {
  const a = new Uint8Array(Math.floor(h.length / 2));
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
  return a;
}

/** Capture a cloud pairing handed over via `#cloud=<base64url(json)>`. */
function captureCloudConfig(): void {
  if (typeof location === "undefined") return;
  const m = location.hash.match(/[#&]cloud=([A-Za-z0-9_-]+)/);
  if (!m) return;
  try {
    const json = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
    const cfg = JSON.parse(json) as CloudCfg;
    if (cfg.device && cfg.key) localStorage.setItem(CLOUD_KEY, JSON.stringify(cfg));
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    /* ignore malformed pairing */
  }
}

let cloudCfgCache: CloudCfg | null | undefined;
function cloudCfg(): CloudCfg | null {
  if (cloudCfgCache !== undefined) return cloudCfgCache;
  captureCloudConfig();
  try {
    const raw = localStorage.getItem(CLOUD_KEY);
    cloudCfgCache = raw ? (JSON.parse(raw) as CloudCfg) : null;
  } catch {
    cloudCfgCache = null;
  }
  return cloudCfgCache;
}

/** Cloud mode: not Tauri, and a cloud pairing is present. */
function isCloud(): boolean {
  return !isTauri() && cloudCfg() !== null;
}

/** A single encrypted WS to the relay, multiplexing RPC + events. */
class CloudLink {
  private key: Uint8Array;
  private device: string;
  private relay: string;
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, Set<Handler>>();
  private enc = new TextEncoder();
  private dec = new TextDecoder();
  /** Reconnect delay (ms), doubling on failure so a dead relay isn't hammered. */
  private backoff = 1000;

  constructor(cfg: CloudCfg) {
    this.key = hexToBytes(cfg.key);
    this.device = cfg.device;
    this.relay = cfg.relay || location.origin;
  }

  private seal(obj: unknown): Uint8Array {
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const ct = xchacha20poly1305(this.key, nonce).encrypt(this.enc.encode(JSON.stringify(obj)));
    const out = new Uint8Array(24 + ct.length);
    out.set(nonce);
    out.set(ct, 24);
    return out;
  }

  private open(data: Uint8Array): unknown | null {
    if (data.length < 24) return null;
    try {
      const pt = xchacha20poly1305(this.key, data.slice(0, 24)).decrypt(data.slice(24));
      return JSON.parse(this.dec.decode(pt));
    } catch {
      return null;
    }
  }

  private async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const wsUrl = this.relay.replace(/^http/, "ws") + `/link/join/${encodeURIComponent(this.device)}`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        this.backoff = 1000;
        resolve();
      };
      ws.onerror = () => reject(new Error("cloud link failed"));
      ws.onmessage = (e) => this.onFrame(new Uint8Array(e.data as ArrayBuffer));
      ws.onclose = () => {
        this.ws = null;
        // Fail in-flight calls so callers see the drop instead of hanging.
        for (const p of this.pending.values()) p.reject(new Error("cloud link closed"));
        this.pending.clear();
        // Live event subscriptions would otherwise go silently dead until the
        // next invoke — reconnect for them with backoff.
        if (this.handlers.size > 0) {
          const delay = this.backoff + Math.floor(Math.random() * (this.backoff / 2));
          this.backoff = Math.min(this.backoff * 2, 30000);
          setTimeout(() => {
            if (!this.ws && this.handlers.size > 0) void this.connect().catch(() => {});
          }, delay);
        }
      };
      this.ws = ws;
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private onFrame(data: Uint8Array): void {
    const msg = this.open(data) as
      | { t: "res"; id: string; ok: boolean; data?: unknown; error?: string }
      | { t: "ev"; topic: string; payload: unknown }
      | null;
    if (!msg) return;
    if (msg.t === "res") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error ?? "command failed"));
    } else if (msg.t === "ev") {
      const set = this.handlers.get(msg.topic);
      if (set) for (const cb of set) cb({ payload: msg.payload });
    }
  }

  async invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    await this.connect();
    const id = `${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(this.seal({ t: "req", id, cmd, args }));
    });
  }

  async listen(event: string, cb: Handler): Promise<UnlistenFn> {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(cb);
    await this.connect();
    return () => {
      set!.delete(cb);
      if (set!.size === 0) this.handlers.delete(event);
    };
  }
}

let cloudLinkInst: CloudLink | null = null;
function cloudLink(): CloudLink {
  if (!cloudLinkInst) cloudLinkInst = new CloudLink(cloudCfg()!);
  return cloudLinkInst;
}

// ---------------------------------------------------------------------------
// invoke
// ---------------------------------------------------------------------------

export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauri()) return tauriInvoke<T>(cmd, args);
  if (isCloud()) return cloudLink().invoke<T>(cmd, args ?? {});

  const token = await ensureToken();
  const res = await fetch(`/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ cmd, args: args ?? {} }),
  });
  if (res.status === 401) {
    // Token went stale (daemon restarted → new code). Drop it and retry once.
    localStorage.removeItem(TOKEN_KEY);
    tokenPromise = null;
    return invoke<T>(cmd, args);
  }
  const body = (await res.json()) as { ok: boolean; data?: T; error?: string };
  if (!body.ok) throw new Error(body.error ?? "command failed");
  return body.data as T;
}

// ---------------------------------------------------------------------------
// listen — one shared WS multiplexed by topic, mimicking Tauri's event bus
// ---------------------------------------------------------------------------

type Handler = (ev: { payload: unknown }) => void;
const handlers = new Map<string, Set<Handler>>();
let socket: WebSocket | null = null;
let connecting = false;

// Reconnect with exponential backoff + jitter so a restarting daemon isn't
// hammered every second by every open tab; a successful open resets the delay.
const WS_BACKOFF_MIN = 1000;
const WS_BACKOFF_MAX = 30000;
let wsBackoff = WS_BACKOFF_MIN;
const nextBackoff = (): number => {
  const d = wsBackoff;
  wsBackoff = Math.min(wsBackoff * 2, WS_BACKOFF_MAX);
  return d + Math.floor(Math.random() * (d / 2));
};

async function ensureSocket(): Promise<void> {
  if (isTauri() || connecting || socket) return;
  connecting = true;
  try {
    const token = await ensureToken();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/events?token=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      wsBackoff = WS_BACKOFF_MIN;
    };
    ws.onmessage = (e) => {
      try {
        const { topic, payload } = JSON.parse(e.data as string);
        const set = handlers.get(topic);
        if (set) for (const cb of set) cb({ payload });
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      socket = null;
      // Reconnect if anyone is still listening.
      if (handlers.size) setTimeout(() => void ensureSocket(), nextBackoff());
    };
    ws.onerror = () => ws.close();
    socket = ws;
  } finally {
    connecting = false;
  }
}

export async function listen<T = unknown>(
  event: string,
  cb: (ev: { payload: T }) => void,
): Promise<UnlistenFn> {
  if (isTauri()) return tauriListen<T>(event, cb as never);
  if (isCloud()) return cloudLink().listen(event, cb as Handler);

  let set = handlers.get(event);
  if (!set) handlers.set(event, (set = new Set()));
  set.add(cb as Handler);
  await ensureSocket();
  return () => {
    set!.delete(cb as Handler);
    if (set!.size === 0) handlers.delete(event);
  };
}

// ---------------------------------------------------------------------------
// Dialogs + version (Tauri plugins have browser fallbacks)
// ---------------------------------------------------------------------------

/** Pick a folder. Native uses the OS dialog; remote prompts for a server-side
 *  path (a proper remote directory browser is a follow-up). */
export async function pickFolder(): Promise<string | null> {
  if (isTauri()) {
    const res = await tauriOpen({ directory: true, multiple: false });
    return typeof res === "string" ? res : null;
  }
  const p = window.prompt("Project path on the daemon host:");
  return p && p.trim() ? p.trim() : null;
}

/** Confirm dialog. Native uses the OS dialog; remote uses `window.confirm`. */
export async function confirmDialog(
  message: string,
  opts?: { title?: string; kind?: "warning" | "info" | "error" },
): Promise<boolean> {
  if (isTauri()) return tauriConfirm(message, opts);
  return window.confirm(`${opts?.title ? opts.title + "\n\n" : ""}${message}`);
}

export async function appVersion(): Promise<string> {
  if (isTauri()) return getVersion();
  return "web";
}

/** A subset of the Tauri Window API the app actually uses. The native call
 *  `getCurrentWindow()` reads `__TAURI_INTERNALS__.metadata`, which is undefined
 *  in a plain browser — hence the shim with the methods (setTheme/setTitle) the
 *  UI relies on. Importing the native fn is safe; only *calling* it touches the
 *  internals, and we only do that under `isTauri()`. */
interface AppWindow {
  setTheme(theme?: string | null): Promise<void>;
  setTitle(title: string): Promise<void>;
}

export function getCurrentWindow(): AppWindow {
  if (isTauri()) return tauriGetCurrentWindow() as unknown as AppWindow;
  return {
    setTheme: async () => {},
    setTitle: async (title: string) => {
      if (typeof document !== "undefined") document.title = title;
    },
  };
}

/** Open a URL in the OS browser (Tauri) or a new tab (remote). */
export async function openUrl(url: string): Promise<void> {
  if (isTauri()) return tauriOpenUrl(url);
  window.open(url, "_blank", "noopener,noreferrer");
}
