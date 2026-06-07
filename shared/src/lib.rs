//! Wire protocol shared by the TUI (producer), the relay server, and — via the
//! same JSON shapes — the web dashboard.
//!
//! Transport convention over WebSocket:
//!   * Control frames travel as **text** frames (JSON, tagged by `type`).
//!   * Raw terminal output travels as **binary** frames (unframed pty bytes).
//!
//! Keeping output as opaque binary means the relay never has to parse or
//! re-encode the stream — it just fans bytes out to viewers.

use serde::{Deserialize, Serialize};

/// Default port the relay listens on.
pub const DEFAULT_PORT: u16 = 8787;

/// Metadata describing a single recorded/streamed terminal session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    /// Human-meaningful label for the session — typically the working directory
    /// or a user-set title. Shown in the dashboard instead of the raw id.
    pub title: String,
    pub cols: u16,
    pub rows: u16,
    pub shell: String,
    /// Unix seconds when the session started syncing.
    pub started_at: i64,
}

/// Which coding agent eterm detected driving the session, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    ClaudeCode,
    Codex,
    Unknown,
}

/// What the detected agent is currently doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Idle,
    Thinking,
    RunningTool,
    WaitingInput,
}

/// A snapshot of agent usage/status, rendered as a card on the dashboard.
/// Fields are optional because detection is heuristic — show what we know.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStatus {
    pub kind: AgentKind,
    pub state: AgentState,
    /// Model id, e.g. "claude-opus-4-8".
    pub model: Option<String>,
    /// Percent of the context window consumed (0–100).
    pub context_pct: Option<f32>,
    pub tokens_in: Option<u64>,
    pub tokens_out: Option<u64>,
    pub cost_usd: Option<f64>,
    /// Human-readable current action, e.g. "Editing app.rs".
    pub action: Option<String>,
}

/// Control messages exchanged on the WebSocket text channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Control {
    /// Producer announces a session (first frame on `/produce/:id`).
    Start(SessionMeta),
    /// A structured event in the timeline (e.g. "claude-prompt-sent").
    Marker { label: String, t: f64 },
    /// The terminal was resized.
    Resize { cols: u16, rows: u16 },
    /// Latest detected agent usage/status for the dashboard's status panel.
    Agent(AgentStatus),
    /// The agent is blocked asking the user to choose — the dashboard renders
    /// this as a prompt with reply buttons.
    PermissionRequest {
        request_id: String,
        prompt: String,
        options: Vec<String>,
    },
    /// Producer is ending the session.
    End,
}

/// Messages sent from a viewer back toward the producer over the **control**
/// channel (`/control/:id`, token-gated). Forwarded verbatim to the TUI, which
/// applies them to its pty.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ViewerMsg {
    /// Raw bytes to inject as terminal input (keystrokes, button replies).
    Input { data: String },
    /// Viewer-initiated resize request.
    Resize { cols: u16, rows: u16 },
}

impl ViewerMsg {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("ViewerMsg serializes")
    }

    pub fn from_json(s: &str) -> Option<Self> {
        serde_json::from_str(s).ok()
    }
}

impl Control {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("Control serializes")
    }

    pub fn from_json(s: &str) -> Option<Self> {
        serde_json::from_str(s).ok()
    }
}
