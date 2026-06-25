//! Mobile access — an HTTP/WS server that runs *inside* the desktop app so a
//! phone on the LAN shares the desktop's LIVE state.
//!
//! Unlike spawning the standalone daemon (its own process, its own pty pool),
//! this server builds its request context from the Tauri app's managed state —
//! the SAME `SessionManager`/`Store` the desktop uses. So a terminal opened on
//! the desktop shows its full scrollback + live output on the phone (and vice
//! versa), and either side can type into the same agent. Agent output reaches
//! phones because the desktop's `TauriSink` tees every event into our broadcast
//! channel (see `event::TauriSink`).
//!
//! Settings → Mobile starts/stops this and shows a scannable QR + code.

use std::collections::HashMap;
use std::net::{TcpListener, UdpSocket};
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
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::sync::{broadcast, oneshot};
use tower_http::services::{ServeDir, ServeFile};

use crate::GitLock;
use crate::event::{Sink, TauriSink};
use crate::serve;
use crate::session::SessionManager;
use crate::settings::SettingsStore;
use crate::store::Store;
use crate::watch::WatchManager;

/// Managed state: the running server (if any).
#[derive(Default)]
pub struct MobileState {
    inner: Mutex<Option<Running>>,
}

struct Running {
    token: String,
    url: String,
    tx: broadcast::Sender<String>,
    /// Dropping this (via `stop`) triggers graceful shutdown of the server.
    shutdown: Option<oneshot::Sender<()>>,
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

/// What Settings → Mobile renders.
#[derive(Serialize, Clone)]
pub struct MobileStatus {
    pub running: bool,
    pub url: String,
    pub code: String,
    /// Inline SVG QR encoding the quick link (`url/#t=code`), or "".
    pub qr_svg: String,
}

impl MobileStatus {
    fn off() -> Self {
        Self { running: false, url: String::new(), code: String::new(), qr_svg: String::new() }
    }
    fn of(r: &Running) -> Self {
        let link = format!("{}/#t={}", r.url, r.token);
        Self { running: true, url: r.url.clone(), code: r.token.clone(), qr_svg: qr_svg(&link) }
    }
}

/// Per-request server state. Handlers build a [`serve::Ctx`] from `app`'s managed
/// state, so requests act on the desktop's live `SessionManager`/`Store`.
#[derive(Clone)]
struct ServeState {
    app: AppHandle,
    tx: broadcast::Sender<String>,
    token: Arc<String>,
}

impl MobileState {
    pub fn status(&self) -> MobileStatus {
        match self.inner.lock().unwrap().as_ref() {
            Some(r) => MobileStatus::of(r),
            None => MobileStatus::off(),
        }
    }

    /// The live event broadcast sender, so `TauriSink` can tee desktop agent
    /// output to connected phones. `None` when mobile access is off.
    pub fn broadcast(&self) -> Option<broadcast::Sender<String>> {
        self.inner.lock().unwrap().as_ref().map(|r| r.tx.clone())
    }

    /// Start the embedded server (idempotent — returns the live status if up).
    pub fn start(&self, app: &AppHandle, port: Option<u16>) -> Result<MobileStatus, String> {
        let mut guard = self.inner.lock().unwrap();
        if let Some(r) = guard.as_ref() {
            return Ok(MobileStatus::of(r));
        }
        let dist = dist_dir(app).ok_or(
            "web bundle not found — build the UI (pnpm -C ide build) or bundle dist as a resource",
        )?;
        let port = free_port(port.unwrap_or(7070));
        let token = serve::gen_token();
        let (tx, _rx) = broadcast::channel::<String>(4096);
        let (sd_tx, sd_rx) = oneshot::channel::<()>();
        let state = ServeState { app: app.clone(), tx: tx.clone(), token: Arc::new(token.clone()) };
        let addr = format!("0.0.0.0:{port}");

        // Own thread + tokio runtime so we don't assume Tauri runs on tokio.
        std::thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("mobile: runtime: {e}");
                    return;
                }
            };
            rt.block_on(async move {
                let serve_dir =
                    ServeDir::new(&dist).fallback(ServeFile::new(dist.join("index.html")));
                let router = Router::new()
                    .route("/healthz", get(|| async { "ok" }))
                    .route("/auth", post(auth))
                    .route("/rpc", post(rpc))
                    .route("/events", get(events))
                    .fallback_service(serve_dir)
                    .with_state(state);
                match tokio::net::TcpListener::bind(&addr).await {
                    Ok(l) => {
                        let _ = axum::serve(l, router)
                            .with_graceful_shutdown(async {
                                let _ = sd_rx.await;
                            })
                            .await;
                    }
                    Err(e) => eprintln!("mobile: bind {addr}: {e}"),
                }
            });
        });

        let host = lan_ip().unwrap_or_else(|| "127.0.0.1".to_string());
        let url = format!("http://{host}:{port}");
        let r = Running { token, url, tx, shutdown: Some(sd_tx) };
        let st = MobileStatus::of(&r);
        *guard = Some(r);
        Ok(st)
    }

    /// Stop the server (graceful shutdown via `Running`'s Drop).
    pub fn stop(&self) -> MobileStatus {
        *self.inner.lock().unwrap() = None;
        MobileStatus::off()
    }
}

// --- HTTP handlers ---

#[derive(serde::Deserialize)]
struct AuthReq {
    code: String,
}

async fn auth(State(st): State<ServeState>, Json(body): Json<AuthReq>) -> impl IntoResponse {
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

async fn rpc(
    State(st): State<ServeState>,
    headers: HeaderMap,
    Json(req): Json<RpcReq>,
) -> impl IntoResponse {
    if !authed(&headers, &st.token) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response();
    }
    let res = tokio::task::spawn_blocking(move || run_cmd(&st.app, &req.cmd, &req.args)).await;
    match res {
        Ok(Ok(v)) => (StatusCode::OK, Json(json!({ "ok": true, "data": v }))).into_response(),
        Ok(Err(m)) => (StatusCode::OK, Json(json!({ "ok": false, "error": m }))).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": "command panicked" })),
        )
            .into_response(),
    }
}

/// Build a `serve::Ctx` from the Tauri app's managed state and dispatch. The sink
/// is a `TauriSink` so a phone-initiated agent also appears on the desktop (and
/// tees back to other phones).
fn run_cmd(app: &AppHandle, cmd: &str, args: &Value) -> Result<Value, String> {
    let store = app.state::<Store>();
    let settings = app.state::<SettingsStore>();
    let sessions = app.state::<SessionManager>();
    let git = app.state::<GitLock>();
    let watch_mgr = app.state::<WatchManager>();
    let sink: Sink = Arc::new(TauriSink(app.clone()));
    let ctx = serve::Ctx {
        store: store.inner(),
        settings: settings.inner(),
        sessions: sessions.inner(),
        git_lock: &git.inner().0,
        watch_mgr: watch_mgr.inner(),
        sink: &sink,
    };
    serve::dispatch(&ctx, cmd, args)
}

async fn events(
    State(st): State<ServeState>,
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
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

fn authed(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| serve::ct_eq(t.trim(), token))
        .unwrap_or(false)
}

// --- helpers ---

fn qr_svg(link: &str) -> String {
    use qrcode::QrCode;
    use qrcode::render::svg;
    match QrCode::new(link.as_bytes()) {
        Ok(code) => code
            .render::<svg::Color>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .build(),
        Err(_) => String::new(),
    }
}

/// The web bundle to serve: bundled resource (packaged) or `ide/dist` (dev).
fn dist_dir(app: &AppHandle) -> Option<PathBuf> {
    let has_index = |d: &std::path::Path| d.join("index.html").exists();

    // Packaged: bundled via tauri.conf `bundle.resources` ("../dist" -> "dist").
    if let Ok(rd) = app.path().resource_dir() {
        for d in [rd.join("dist"), rd.join("_up_").join("dist"), rd.clone()] {
            if has_index(&d) {
                return Some(d);
            }
        }
    }
    // Dev: <…>/ide/dist relative to the running binary.
    if let Ok(exe) = std::env::current_exe() {
        for anc in exe.ancestors() {
            if anc.ends_with("src-tauri") {
                if let Some(ide) = anc.parent() {
                    let d = ide.join("dist");
                    if has_index(&d) {
                        return Some(d);
                    }
                }
            }
        }
    }
    None
}

/// First free TCP port at/after `start` (so a clash doesn't kill the server).
fn free_port(start: u16) -> u16 {
    for p in start..start.saturating_add(50) {
        if TcpListener::bind(("0.0.0.0", p)).is_ok() {
            return p;
        }
    }
    start
}

/// Best-effort primary LAN IPv4 for the URL/QR.
fn lan_ip() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    Some(sock.local_addr().ok()?.ip().to_string())
}
