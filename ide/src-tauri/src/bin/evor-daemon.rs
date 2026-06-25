//! evor-daemon — headless LAN backend host for EvorIDE.
//!
//! Runs the *same* IDE backend as the desktop app (the file/git/pty/task command
//! surface + the live event streams) over HTTP/WebSocket on the local network,
//! and serves the web UI bundle. A browser on another machine opens the printed
//! URL, enters the session code, and gets the exact same EvorIDE — the React app
//! is byte-for-byte identical; only its transport (`ide/src/lib/bridge.ts`)
//! switches from native Tauri IPC to HTTP `/rpc` + WS `/events`.
//!
//! It reuses `ide_lib` directly rather than reimplementing anything, so the
//! security gates (`guard::confine` on every path, the run-config trust gate)
//! cannot drift from the desktop app — a hard requirement (see CLAUDE.md).
//!
//! ## Security posture (local-first)
//! * Binds the LAN by default so another machine can reach it ⇒ a bearer token
//!   is MANDATORY on every `/rpc` call and `/events` socket. `--bind 127.0.0.1`
//!   restricts to loopback (tunnel-only) when you don't want LAN exposure.
//! * `guard::confine` still runs server-side on every path — the path now
//!   crossed a network, so it is *less* trusted, not more.
//! * Secrets (e.g. the Jira token) live only on this host and are never sent to
//!   the browser; the UI only ever learns `has_token`.
//! * Plaintext over a LAN is sniffable — fine on a trusted network; tunnel or
//!   put a TLS terminator in front for anything untrusted. (TLS is a follow-up.)
//!
//! Usage: `evor-daemon init [--port 7070] [--bind 0.0.0.0] [--data-dir PATH]`

use std::collections::HashMap;
use std::net::{SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
};
use serde_json::{Value, json};
use tokio::sync::broadcast;
use tower_http::services::{ServeDir, ServeFile};

use ide_lib::event::{EventSink, Sink};
use ide_lib::serve;
use ide_lib::session::SessionManager;
use ide_lib::settings::SettingsStore;
use ide_lib::store::Store;
use ide_lib::watch::WatchManager;

/// Shared backend state, cloned into every request handler. Each piece is the
/// same type the desktop app `.manage()`s — constructed once here and shared.
#[derive(Clone)]
struct AppState {
    store: Arc<Store>,
    settings: Arc<SettingsStore>,
    sessions: Arc<SessionManager>,
    /// Serializes mutating git ops, exactly like the desktop `GitLock`.
    git_lock: Arc<Mutex<()>>,
    watch_mgr: Arc<WatchManager>,
    /// Event fan-out to connected browsers (the pty/agent/fs streams).
    sink: Sink,
    tx: broadcast::Sender<String>,
    /// The session secret; compared in constant time on every request.
    token: Arc<String>,
}

/// `EventSink` that fans every backend event out to connected WebSocket clients.
/// One frame = `{"topic": "...", "payload": {...}}`, which the frontend `listen()`
/// shim routes exactly like a native Tauri event.
struct DaemonSink {
    tx: broadcast::Sender<String>,
}

impl EventSink for DaemonSink {
    fn emit(&self, topic: &'static str, payload: Value) {
        let frame = json!({ "topic": topic, "payload": payload }).to_string();
        // Err only means "no receivers right now" — fine, drop it.
        let _ = self.tx.send(frame);
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    // First positional (after the program) is the subcommand; `init` is the only
    // one today and also the default, so `evor-daemon` alone works too.
    let sub = args.get(1).map(String::as_str).unwrap_or("init");
    if matches!(sub, "-h" | "--help" | "help") {
        print_usage();
        return;
    }

    let mut port: u16 = 7070;
    let mut bind = "0.0.0.0".to_string();
    let mut data_dir: Option<PathBuf> = None;
    let mut dist_dir: Option<PathBuf> = None;
    let mut fixed_token: Option<String> = None;
    let mut it = args.iter().skip(1).peekable();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--port" => port = it.next().and_then(|s| s.parse().ok()).unwrap_or(port),
            "--bind" => bind = it.next().cloned().unwrap_or(bind),
            "--data-dir" => data_dir = it.next().map(PathBuf::from),
            "--dist" => dist_dir = it.next().map(PathBuf::from),
            // Caller-supplied session token (e.g. the IDE, so it can show the
            // QR/code without parsing our stdout). Hex only, length-bounded.
            "--token" => {
                fixed_token = it.next().filter(|t| {
                    t.len() >= 8 && t.len() <= 128 && t.chars().all(|c| c.is_ascii_hexdigit())
                }).cloned()
            }
            _ => {}
        }
    }

    let data_dir = data_dir.unwrap_or_else(default_data_dir);
    std::fs::create_dir_all(&data_dir).ok();
    let dist = dist_dir.unwrap_or_else(default_dist_dir);
    if !dist.join("index.html").exists() {
        eprintln!(
            "warning: web UI bundle not found at {} — build it with `pnpm -C ide build`, or pass --dist",
            dist.display()
        );
    }

    // Same state objects the desktop app manages, just owned by the daemon.
    let store = Arc::new(Store::load(data_dir.join("eterm-ide.json")));
    let settings = Arc::new(SettingsStore::load(data_dir.join("settings.json")));
    let sessions = Arc::new(SessionManager::new());
    let watch_mgr = Arc::new(WatchManager::default());
    let (tx, _rx) = broadcast::channel::<String>(4096);
    let sink: Sink = Arc::new(DaemonSink { tx: tx.clone() });
    let token = Arc::new(fixed_token.unwrap_or_else(serve::gen_token));

    // Start file watchers for already-open projects, feeding the same `fs-changed`
    // stream the desktop app uses — so the remote explorer auto-refreshes too.
    ide_lib::watch::sync(&store, &watch_mgr, sink.clone());

    let state = AppState {
        store,
        settings,
        sessions,
        git_lock: Arc::new(Mutex::new(())),
        watch_mgr,
        sink,
        tx,
        token,
    };

    let serve_dir = ServeDir::new(&dist).fallback(ServeFile::new(dist.join("index.html")));
    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/auth", post(auth))
        .route("/rpc", post(rpc))
        .route("/events", get(events))
        .fallback_service(serve_dir)
        .with_state(state.clone());

    let addr: SocketAddr = format!("{bind}:{port}")
        .parse()
        .expect("invalid --bind/--port");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("cannot bind {addr}: {e}"));

    print_banner(&bind, port, &state.token, &data_dir);
    axum::serve(listener, app).await.expect("server crashed");
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct AuthReq {
    code: String,
}

/// Exchange the printed session code for confirmation. The code *is* the bearer
/// token (single LAN secret); this endpoint just lets the SPA validate it before
/// storing, so a wrong code shows an error instead of silently failing later.
async fn auth(State(st): State<AppState>, Json(body): Json<AuthReq>) -> impl IntoResponse {
    if serve::ct_eq(body.code.trim(), &st.token) {
        (StatusCode::OK, Json(json!({ "token": &*st.token }))).into_response()
    } else {
        (StatusCode::UNAUTHORIZED, Json(json!({ "error": "bad code" }))).into_response()
    }
}

#[derive(serde::Deserialize)]
struct RpcReq {
    cmd: String,
    #[serde(default)]
    args: Value,
}

/// Commands a *remote* client must never invoke, regardless of viewport or UI.
/// The browser is less trusted than the desktop app (its calls crossed a LAN), so
/// risky project-management actions are refused server-side — hiding the buttons
/// in the UI is not enough. The standout is `add_project`: it registers an
/// arbitrary filesystem path as a project root, which `guard::confine` then treats
/// as allowed — i.e. it can *widen* the confinement boundary that protects every
/// other path command. Opening a new project therefore happens only at the
/// desktop, where the OS folder picker is the gate. (See CLAUDE.md guardrail #1.)
const REMOTE_DENIED: &[&str] = &[
    "add_project",            // "open new project" — would escape path confinement
    "remove_project",         // destructive: drops a project + its agents/tasks
    "create_super_project",
    "rename_super_project",
    "delete_super_project",
    "set_super_project_members",
];

/// One endpoint for the whole command surface: `{cmd, args}` → result. Mirrors
/// the desktop `invoke()` contract so the frontend bridge is a thin swap.
async fn rpc(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RpcReq>,
) -> impl IntoResponse {
    if !authed(&headers, &st.token) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response();
    }
    if REMOTE_DENIED.contains(&req.cmd.as_str()) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "ok": false, "error": "this action is only available on the desktop app" })),
        )
            .into_response();
    }
    // Commands are blocking (sqlite, git, pty, fs) — run off the async executor.
    let res = tokio::task::spawn_blocking(move || {
        let ctx = serve::Ctx {
            store: st.store.as_ref(),
            settings: st.settings.as_ref(),
            sessions: st.sessions.as_ref(),
            git_lock: st.git_lock.as_ref(),
            watch_mgr: st.watch_mgr.as_ref(),
            sink: &st.sink,
        };
        serve::dispatch(&ctx, &req.cmd, &req.args)
    })
    .await;
    match res {
        Ok(Ok(value)) => (StatusCode::OK, Json(json!({ "ok": true, "data": value }))).into_response(),
        Ok(Err(msg)) => {
            (StatusCode::OK, Json(json!({ "ok": false, "error": msg }))).into_response()
        }
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": "command panicked" })),
        )
            .into_response(),
    }
}

/// Live event stream (pty output, agent-waiting, rate-limit, fs-changed). Auth is
/// via `?token=` because browsers can't set headers on a WebSocket handshake.
async fn events(
    State(st): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let ok = q.get("token").map(|t| serve::ct_eq(t, &st.token)).unwrap_or(false);
    if !ok {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let rx = st.tx.subscribe();
    ws.on_upgrade(move |socket| pump_events(socket, rx)).into_response()
}

async fn pump_events(mut socket: WebSocket, mut rx: broadcast::Receiver<String>) {
    loop {
        match rx.recv().await {
            Ok(frame) => {
                if socket.send(Message::Text(frame.into())).await.is_err() {
                    break; // client gone
                }
            }
            // Slow client fell behind the ring buffer — keep going with newer events.
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}


/// Authorization: `Bearer <token>` header, constant-time compared.
fn authed(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| serve::ct_eq(t.trim(), token))
        .unwrap_or(false)
}


fn default_data_dir() -> PathBuf {
    let id = "com.rbn.ide"; // tauri.conf.json identifier — shares the desktop store
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support").join(id)
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join(id)
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join(id)
    }
}

/// Where the web UI bundle lives relative to the binary in dev (`ide/dist`).
fn default_dist_dir() -> PathBuf {
    // …/ide/src-tauri/target/<profile>/evor-daemon → up to …/ide/dist
    if let Ok(exe) = std::env::current_exe() {
        if let Some(target) = exe.ancestors().find(|p| p.ends_with("src-tauri")) {
            if let Some(ide) = target.parent() {
                return ide.join("dist");
            }
        }
    }
    PathBuf::from("ide/dist")
}

/// Best-effort primary LAN IPv4 (so the printed URL is reachable from another
/// machine, not just `0.0.0.0`). Uses a connect-to-discover-local-addr trick; no
/// packet is actually sent.
fn lan_ip() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    Some(sock.local_addr().ok()?.ip().to_string())
}

fn print_banner(bind: &str, port: u16, token: &str, data_dir: &PathBuf) {
    let host = if bind == "0.0.0.0" {
        lan_ip().unwrap_or_else(|| "127.0.0.1".to_string())
    } else {
        bind.to_string()
    };
    let url = format!("http://{host}:{port}");
    println!("\n  EvorIDE daemon — your IDE, served on the network\n");
    println!("  ┌──────────────────────────────────────────────");
    println!("  │  Open from another machine:");
    println!("  │    {url}");
    println!("  │  Session code (enter once in the browser):");
    println!("  │    {token}");
    println!("  │  Quick link (auto-fills the code):");
    println!("  │    {url}/#t={token}");
    println!("  └──────────────────────────────────────────────");
    println!("\n  data dir: {}", data_dir.display());
    if bind == "0.0.0.0" {
        println!("  bound to the LAN — anyone on this network with the code can connect.");
        println!("  use `--bind 127.0.0.1` for loopback/tunnel-only.\n");
    } else {
        println!("  bound to {bind} only.\n");
    }
}

fn print_usage() {
    println!(
        "evor-daemon — headless LAN backend host for EvorIDE\n\n\
         USAGE:\n  evor-daemon [init] [--port <N>] [--bind <ADDR>] [--data-dir <PATH>] [--dist <PATH>]\n\n\
         Serves the web UI + the IDE backend (commands + live streams) so a browser\n\
         on another machine gets the same EvorIDE. Defaults: --port 7070 --bind 0.0.0.0.\n"
    );
}
