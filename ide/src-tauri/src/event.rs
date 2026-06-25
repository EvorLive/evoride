//! Transport-agnostic event sink.
//!
//! The IDE backend streams pty output, agent state, and fs-change notifications
//! up to a frontend. In the Tauri desktop app that frontend is the in-process
//! webview, so events go through [`tauri::Emitter::emit`]. In headless
//! `evor-daemon` mode the *same* events fan out to one or more remote browsers
//! over a WebSocket. Decoupling the producers ([`crate::session`],
//! [`crate::watch`]) from Tauri behind this trait is what lets a single backend
//! serve both transports without the producers knowing which one they feed.
//!
//! `topic` mirrors the Tauri event name the webview already listens on
//! (e.g. `"pty-output"`); `payload` is the JSON event body. The remote bridge in
//! the daemon wraps each `{topic, payload}` into one WS frame so the frontend's
//! `listen()` shim can route it exactly like a native Tauri event.

use serde::Serialize;
use std::sync::Arc;

/// A destination for backend → frontend events.
pub trait EventSink: Send + Sync {
    fn emit(&self, topic: &'static str, payload: serde_json::Value);
}

/// Shared, cheaply-cloneable handle to a sink (moved into reader/watcher threads).
pub type Sink = Arc<dyn EventSink>;

/// Emit a typed payload, serializing it to JSON. Producers call this so they can
/// keep their existing strongly-typed event structs. A serialization failure
/// (which shouldn't happen for these plain structs) degrades to `null` rather
/// than panicking a backend thread — a dropped event is never worth a DoS.
pub fn emit<T: Serialize>(sink: &dyn EventSink, topic: &'static str, payload: T) {
    sink.emit(
        topic,
        serde_json::to_value(payload).unwrap_or(serde_json::Value::Null),
    );
}

/// `EventSink` backed by the Tauri webview — the desktop app's transport.
pub struct TauriSink(pub tauri::AppHandle);

impl EventSink for TauriSink {
    fn emit(&self, topic: &'static str, payload: serde_json::Value) {
        use tauri::{Emitter, Manager};
        // Emit the Value as-is so the webview receives the object (not a
        // JSON-encoded string); the frontend reads `ev.payload.<field>`.
        let _ = self.0.emit(topic, payload.clone());
        // Tee to any phones connected via "Mobile access" so a terminal opened
        // on the desktop streams to mobile too (same live agent on both).
        if let Some(m) = self.0.try_state::<crate::mobile::MobileState>() {
            if let Some(tx) = m.broadcast() {
                let _ = tx.send(crate::serve::frame(topic, &payload));
            }
        }
        // Tee to a connected evor.dev cloud client (encrypted downstream).
        if let Some(c) = self.0.try_state::<crate::cloud::CloudState>() {
            if let Some(tx) = c.broadcast() {
                let _ = tx.send(crate::cloud::event_frame(topic, &payload));
            }
        }
    }
}

/// A sink that drops every event. Used for headless contexts before any client
/// has connected, and in tests.
pub struct NullSink;

impl EventSink for NullSink {
    fn emit(&self, _topic: &'static str, _payload: serde_json::Value) {}
}
