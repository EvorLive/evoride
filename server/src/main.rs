//! eterm relay server.
//!
//! Producers (the TUI) connect to `/produce/:id` and push control + raw output
//! frames. Viewers (the web dashboard) connect to `/view/:id` and receive the
//! current scrollback snapshot followed by the live stream. The relay never
//! parses the terminal bytes — it only buffers scrollback and fans out frames.

mod hub;

use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::routing::get;
use futures_util::StreamExt;
use shared::{Control, DEFAULT_PORT, ViewerMsg};
use std::collections::HashMap;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

use hub::{AppState, Frame};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let state = Arc::new(AppState::new());

    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any);

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/sessions", get(list_sessions))
        .route("/produce/{id}", get(produce_ws))
        .route("/view/{id}", get(view_ws))
        .route("/control/{id}", get(control_ws))
        .layer(cors)
        .with_state(state);

    let addr = format!("0.0.0.0:{}", DEFAULT_PORT);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("eterm relay listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

/// JSON list of known sessions, for the dashboard's session picker.
async fn list_sessions(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    axum::Json(state.list())
}

async fn produce_ws(
    ws: WebSocketUpgrade,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let token = q.get("token").cloned().unwrap_or_default();
    ws.on_upgrade(move |socket| handle_produce(socket, id, token, state))
}

async fn control_ws(
    ws: WebSocketUpgrade,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let token = q.get("token").cloned().unwrap_or_default();
    ws.on_upgrade(move |socket| handle_control(socket, id, token, state))
}

async fn view_ws(
    ws: WebSocketUpgrade,
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_view(socket, id, state))
}

/// Ingest a producer stream (control as text, output as binary) while also
/// forwarding viewer control messages back down the same socket.
async fn handle_produce(
    socket: WebSocket,
    id: String,
    token: String,
    state: Arc<AppState>,
) {
    // A hub exists for the whole session lifetime so viewers can attach anytime.
    state.ensure_hub(&id);
    state.set_control_token(&id, &token);

    // Channel of viewer→producer messages to write back to the TUI.
    let mut to_producer = state.take_producer_rx(&id);
    let (mut sink, mut stream) = socket.split();

    loop {
        tokio::select! {
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if let Some(ctrl) = Control::from_json(text.as_str()) {
                            state.apply_control(&id, &ctrl);
                            state.broadcast(&id, Frame::Control(ctrl));
                        }
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        state.append_output(&id, &bytes);
                        state.broadcast(&id, Frame::Output(bytes.to_vec()));
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
            // Forward a viewer control message to the producer as a text frame.
            forwarded = recv_opt(&mut to_producer) => {
                use futures_util::SinkExt;
                if let Some(text) = forwarded {
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    }

    // Producer gone: flag ended and notify viewers (scrollback is retained).
    state.mark_ended(&id);
    state.broadcast(&id, Frame::Control(Control::End));
}

/// Await the next producer-bound message, or never resolve if control is off
/// (no receiver), so `select!` simply waits on the producer stream instead.
async fn recv_opt(
    rx: &mut Option<tokio::sync::mpsc::UnboundedReceiver<String>>,
) -> Option<String> {
    match rx {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

/// Token-gated control socket: validates the secret, then forwards each viewer
/// `ViewerMsg` to the producer. `/view` stays strictly read-only.
async fn handle_control(
    mut socket: WebSocket,
    id: String,
    token: String,
    state: Arc<AppState>,
) {
    if !state.control_authorized(&id, &token) {
        let _ = socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 4003,
                reason: "control not authorized".into(),
            })))
            .await;
        return;
    }
    let Some(producer) = state.producer_sender(&id) else {
        return;
    };

    while let Some(Ok(msg)) = socket.next().await {
        match msg {
            Message::Text(text) => {
                // Validate it parses as a ViewerMsg before forwarding.
                if ViewerMsg::from_json(text.as_str()).is_some() {
                    if producer.send(text.to_string()).is_err() {
                        break; // producer gone
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
}

/// Replay scrollback to a fresh viewer, then forward the live stream.
async fn handle_view(mut socket: WebSocket, id: String, state: Arc<AppState>) {
    let Some(snap) = state.subscribe(&id) else {
        let _ = socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 4004,
                reason: "no such session".into(),
            })))
            .await;
        return;
    };
    let mut rx = snap.rx;

    // 1) Announce the session shape so the client can size its emulator.
    if let Some(meta) = snap.meta {
        let _ = socket
            .send(Message::Text(Control::Start(meta).to_json().into()))
            .await;
    }
    // 2) Replay the latest agent status so the status card paints right away.
    if let Some(agent) = snap.last_agent {
        let _ = socket
            .send(Message::Text(agent.to_json().into()))
            .await;
    }
    // 3) Hand over the accumulated scrollback as one binary blob.
    if !snap.scrollback.is_empty() {
        if socket
            .send(Message::Binary(snap.scrollback.into()))
            .await
            .is_err()
        {
            return;
        }
    }
    // 3) Live tail.
    loop {
        match rx.recv().await {
            Ok(Frame::Output(bytes)) => {
                if socket.send(Message::Binary(bytes.into())).await.is_err() {
                    break;
                }
            }
            Ok(Frame::Control(ctrl)) => {
                if socket
                    .send(Message::Text(ctrl.to_json().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            // Slow viewer fell behind the ring buffer — keep going from now.
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
}
