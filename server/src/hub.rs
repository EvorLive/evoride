//! In-memory session registry. Each session has a capped scrollback buffer and
//! a broadcast channel that fans live frames out to all attached viewers.

use crate::db::Db;
use serde::Serialize;
use shared::{Control, SessionMeta};
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::{broadcast, mpsc};

/// A session row for the dashboard's `/sessions` list, including liveness.
#[derive(Serialize)]
pub struct SessionSummary {
    #[serde(flatten)]
    pub meta: SessionMeta,
    pub ended: bool,
}

/// Max bytes of scrollback retained per session for late-joining viewers.
const SCROLLBACK_CAP: usize = 512 * 1024;
/// Broadcast ring capacity; slow viewers that exceed it get a `Lagged` skip.
const BROADCAST_CAP: usize = 2048;

/// A live frame relayed to viewers.
#[derive(Clone)]
pub enum Frame {
    Output(Vec<u8>),
    Control(Control),
}

/// Everything a freshly-attached viewer needs to render immediately.
pub struct ViewerSnapshot {
    pub meta: Option<SessionMeta>,
    pub last_agent: Option<Control>,
    pub scrollback: Vec<u8>,
    pub rx: broadcast::Receiver<Frame>,
}

struct Hub {
    meta: Option<SessionMeta>,
    scrollback: Vec<u8>,
    /// Most recent agent status, replayed to viewers as they attach.
    last_agent: Option<Control>,
    ended: bool,
    tx: broadcast::Sender<Frame>,
    /// Secret required on `/control/:id`; set by the producer on connect.
    control_token: Option<String>,
    /// Forwards viewer control messages (raw ViewerMsg JSON) to the producer.
    to_producer_tx: mpsc::UnboundedSender<String>,
    /// Taken once by the producer handler to receive those messages.
    to_producer_rx: Option<mpsc::UnboundedReceiver<String>>,
}

pub struct AppState {
    sessions: Mutex<HashMap<String, Hub>>,
    /// Durable store for accounts, devices, and the notification inbox. The
    /// relay half above stays in-memory; this is the persistent half.
    pub db: Db,
}

impl AppState {
    pub fn new(db: Db) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            db,
        }
    }

    /// Create the hub for `id` if it doesn't exist yet.
    pub fn ensure_hub(&self, id: &str) {
        let mut map = self.sessions.lock().unwrap();
        map.entry(id.to_string()).or_insert_with(|| {
            let (tx, _) = broadcast::channel(BROADCAST_CAP);
            let (to_producer_tx, to_producer_rx) = mpsc::unbounded_channel();
            Hub {
                meta: None,
                scrollback: Vec::new(),
                last_agent: None,
                ended: false,
                tx,
                control_token: None,
                to_producer_tx,
                to_producer_rx: Some(to_producer_rx),
            }
        });
    }

    /// Update hub metadata in response to a control frame.
    pub fn apply_control(&self, id: &str, ctrl: &Control) {
        let mut map = self.sessions.lock().unwrap();
        if let Some(hub) = map.get_mut(id) {
            match ctrl {
                Control::Start(meta) => {
                    hub.meta = Some(meta.clone());
                    hub.ended = false;
                }
                Control::Resize { cols, rows } => {
                    if let Some(meta) = hub.meta.as_mut() {
                        meta.cols = *cols;
                        meta.rows = *rows;
                    }
                }
                Control::Agent(_) => {
                    hub.last_agent = Some(ctrl.clone());
                }
                _ => {}
            }
        }
    }

    /// Append raw output to scrollback, trimming from the front past the cap.
    pub fn append_output(&self, id: &str, bytes: &[u8]) {
        let mut map = self.sessions.lock().unwrap();
        if let Some(hub) = map.get_mut(id) {
            hub.scrollback.extend_from_slice(bytes);
            let len = hub.scrollback.len();
            if len > SCROLLBACK_CAP {
                hub.scrollback.drain(0..len - SCROLLBACK_CAP);
            }
        }
    }

    /// Push a frame to all viewers. No-op if nobody is listening.
    pub fn broadcast(&self, id: &str, frame: Frame) {
        let map = self.sessions.lock().unwrap();
        if let Some(hub) = map.get(id) {
            let _ = hub.tx.send(frame);
        }
    }

    /// Record the producer's control token (empty string disables control).
    pub fn set_control_token(&self, id: &str, token: &str) {
        let mut map = self.sessions.lock().unwrap();
        if let Some(hub) = map.get_mut(id) {
            hub.control_token = if token.is_empty() {
                None
            } else {
                Some(token.to_string())
            };
        }
    }

    /// Take the producer-bound receiver (once, by the producer handler).
    pub fn take_producer_rx(&self, id: &str) -> Option<mpsc::UnboundedReceiver<String>> {
        let mut map = self.sessions.lock().unwrap();
        map.get_mut(id).and_then(|h| h.to_producer_rx.take())
    }

    /// A sender to forward viewer control messages to the producer.
    pub fn producer_sender(&self, id: &str) -> Option<mpsc::UnboundedSender<String>> {
        let map = self.sessions.lock().unwrap();
        map.get(id).map(|h| h.to_producer_tx.clone())
    }

    /// Constant-time-ish check that control is enabled and the token matches.
    pub fn control_authorized(&self, id: &str, token: &str) -> bool {
        let map = self.sessions.lock().unwrap();
        match map.get(id).and_then(|h| h.control_token.as_deref()) {
            Some(expected) => !token.is_empty() && expected == token,
            None => false,
        }
    }

    pub fn mark_ended(&self, id: &str) {
        let mut map = self.sessions.lock().unwrap();
        if let Some(hub) = map.get_mut(id) {
            hub.ended = true;
        }
    }

    /// Snapshot for a new viewer: metadata, last agent status, current
    /// scrollback, and a live receiver.
    pub fn subscribe(&self, id: &str) -> Option<ViewerSnapshot> {
        let map = self.sessions.lock().unwrap();
        let hub = map.get(id)?;
        Some(ViewerSnapshot {
            meta: hub.meta.clone(),
            last_agent: hub.last_agent.clone(),
            scrollback: hub.scrollback.clone(),
            rx: hub.tx.subscribe(),
        })
    }

    /// Summaries for every known session (for `/sessions`), newest first.
    pub fn list(&self) -> Vec<SessionSummary> {
        let map = self.sessions.lock().unwrap();
        let mut out: Vec<SessionSummary> = map
            .values()
            .filter_map(|h| {
                h.meta.clone().map(|meta| SessionSummary {
                    meta,
                    ended: h.ended,
                })
            })
            .collect();
        out.sort_by(|a, b| b.meta.started_at.cmp(&a.meta.started_at));
        out
    }
}
