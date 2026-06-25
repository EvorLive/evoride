//! Loopback RPC — an always-on `127.0.0.1`-only HTTP endpoint that lets the
//! bundled `evor` CLI (see `src/bin/evor.rs`) act on the desktop's LIVE state.
//!
//! When the desktop spawns an agent pty it injects `EVORIDE_RPC` (this server's
//! URL) and `EVORIDE_RPC_TOKEN` into the child env. The `evor` binary appends to
//! the same `$EVORIDE_TASKS` / `$EVORIDE_EDITS` JSONL channels as before (the
//! guaranteed-correct floor), then calls `flush_agent_tasks` here so the change
//! reconciles immediately and the UI updates live instead of waiting for the
//! next poll. Reads (`evor task list`) hit `agent_tasks` for fresh data.
//!
//! ## Security posture
//! * Bound to `127.0.0.1` only — never the LAN. A bearer token (same generator
//!   as the mobile/daemon servers) is required on every call; without it the
//!   endpoint is unreachable from another machine and gated from local non-child
//!   processes that don't know the per-launch token.
//! * Every command still flows through `serve::dispatch` / `dispatch_app`, so the
//!   `guard::confine` path gate and run-config trust gate cannot be bypassed.
//! * The CLI is given exactly the agent's own task channel — it can do nothing a
//!   pty child couldn't already do by appending the JSONL itself.

use std::net::TcpListener;
use std::sync::Arc;

use axum::{
    Json, Router,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
};
use serde_json::{Value, json};
use tauri::AppHandle;

use crate::serve;

#[derive(Clone)]
struct State {
    app: AppHandle,
    token: Arc<String>,
}

/// Start the loopback RPC server on a free `127.0.0.1` port. Returns
/// `(url, token)` to inject into spawned ptys, or `None` if no port could be
/// bound (degrades gracefully — the `evor` CLI falls back to JSONL append).
pub fn start(app: &AppHandle) -> Option<(String, String)> {
    let port = free_loopback_port()?;
    let token = serve::gen_token();
    let url = format!("http://127.0.0.1:{port}");
    let state = State { app: app.clone(), token: Arc::new(token.clone()) };
    let addr = format!("127.0.0.1:{port}");

    // Own thread + runtime so we don't assume Tauri runs on tokio (mirrors
    // `mobile.rs`). This server lives for the whole app run; no shutdown handle.
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => {
                eprintln!("localrpc: runtime: {e}");
                return;
            }
        };
        rt.block_on(async move {
            let router = Router::new()
                .route("/rpc", post(rpc))
                .with_state(state);
            match tokio::net::TcpListener::bind(&addr).await {
                Ok(l) => {
                    let _ = axum::serve(l, router).await;
                }
                Err(e) => eprintln!("localrpc: bind {addr}: {e}"),
            }
        });
    });

    Some((url, token))
}

#[derive(serde::Deserialize)]
struct RpcReq {
    cmd: String,
    #[serde(default)]
    args: Value,
}

async fn rpc(
    axum::extract::State(st): axum::extract::State<State>,
    headers: HeaderMap,
    Json(req): Json<RpcReq>,
) -> impl IntoResponse {
    if !authed(&headers, &st.token) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response();
    }
    // Commands are blocking (sqlite/fs) — run off the async executor.
    let res =
        tokio::task::spawn_blocking(move || crate::dispatch_app(&st.app, &req.cmd, &req.args)).await;
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

fn authed(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| serve::ct_eq(t.trim(), token))
        .unwrap_or(false)
}

/// First free loopback TCP port (let the OS pick via `:0`).
fn free_loopback_port() -> Option<u16> {
    let l = TcpListener::bind("127.0.0.1:0").ok()?;
    l.local_addr().ok().map(|a| a.port())
}
