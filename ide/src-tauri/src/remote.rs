//! Remote-control bridge to the hosted Evor dashboard (evor.dev).
//!
//! Two directions:
//!   * **Publish** (best-effort): when a local agent starts/stops waiting for
//!     input, the frontend calls [`notify`] / [`resolve`], which POST to the
//!     device API so the question shows up in the user's inbox anywhere.
//!   * **Reply** (background poller): [`spawn_poller`] runs a thread that polls
//!     the device API for replies the user made remotely, writes them into the
//!     matching agent's pty, then acknowledges them.
//!
//! Auth is a per-device bearer token minted in the dashboard and stored in
//! `~/.evoride/secrets.json` (0600) — it is never returned to the webview.
//! Everything here is best-effort: with remote control disabled, unconfigured,
//! or the network down, it quietly no-ops and the IDE works exactly as before.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::session::SessionManager;
use crate::settings::SettingsStore;

const POLL_INTERVAL: Duration = Duration::from_secs(3);
/// When polls fail (server down, network out), back off up to this cap instead
/// of retrying every 3 s forever. One success snaps back to POLL_INTERVAL.
const POLL_MAX_INTERVAL: Duration = Duration::from_secs(60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone)]
struct RemoteConfig {
    base: String,
    token: String,
}

/// What the Settings → Remote panel needs to render its state. The token itself
/// is never exposed — only whether one is stored.
#[derive(Serialize)]
pub struct RemoteStatus {
    pub enabled: bool,
    pub url: String,
    pub has_token: bool,
    /// enabled AND a valid URL AND a token present — i.e. actually live.
    pub configured: bool,
}

/// Validate + normalize the dashboard base URL. https is required, except a
/// localhost host may use http for a self-hosted dev instance. Rejects
/// whitespace/control chars to keep it off the SSRF / header-injection surface
/// (mirrors the Jira base-URL gate).
pub fn validate_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err("server URL is empty".into());
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("server URL has invalid characters".into());
    }
    let host_part = if let Some(rest) = url.strip_prefix("https://") {
        rest
    } else if let Some(rest) = url.strip_prefix("http://") {
        let host = rest.split('/').next().unwrap_or("");
        let host = host.split(':').next().unwrap_or("");
        if host != "localhost" && host != "127.0.0.1" && host != "[::1]" {
            return Err("use https:// (http is allowed only for localhost)".into());
        }
        rest
    } else {
        return Err("server URL must start with https://".into());
    };
    if host_part.is_empty() {
        return Err("server URL has no host".into());
    }
    Ok(url.to_string())
}

/// Current live config, or `None` when remote control is off / unconfigured.
fn current_config(app: &AppHandle) -> Option<RemoteConfig> {
    let s = app.state::<SettingsStore>().get();
    if !s.remote_enabled {
        return None;
    }
    let base = validate_url(&s.remote_url).ok()?;
    let token = crate::secrets::load_evor_token()?;
    Some(RemoteConfig { base, token })
}

fn client() -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .ok()
}

/// Settings-panel view of remote-control state.
pub fn status(app: &AppHandle) -> RemoteStatus {
    let s = app.state::<SettingsStore>().get();
    let has_token = crate::secrets::has_evor_token();
    let url_ok = validate_url(&s.remote_url).is_ok();
    RemoteStatus {
        enabled: s.remote_enabled,
        url: s.remote_url.clone(),
        has_token,
        configured: s.remote_enabled && url_ok && has_token,
    }
}

#[derive(Serialize)]
struct NotifyBody {
    agent_id: String,
    project: String,
    title: String,
    question: String,
    options: Vec<String>,
    text_mode: bool,
    kind: String,
}

/// Best-effort publish of a waiting notification. Spawns a thread so the IPC
/// call returns immediately; the server upserts by (device, agent) so repeat
/// calls as the question evolves just refresh the one open notification.
#[allow(clippy::too_many_arguments)]
pub fn notify(
    app: AppHandle,
    agent_id: String,
    project: String,
    title: String,
    question: String,
    options: Vec<String>,
    text_mode: bool,
    kind: String,
) {
    std::thread::spawn(move || {
        let Some(cfg) = current_config(&app) else {
            return;
        };
        let Some(cl) = client() else {
            return;
        };
        let body = NotifyBody {
            agent_id,
            project,
            title,
            question,
            options,
            text_mode,
            kind,
        };
        let _ = cl
            .post(format!("{}/device/notify", cfg.base))
            .bearer_auth(&cfg.token)
            .json(&body)
            .send();
    });
}

/// Best-effort: the agent stopped waiting locally — clear its remote prompt.
pub fn resolve(app: AppHandle, agent_id: String) {
    std::thread::spawn(move || {
        let Some(cfg) = current_config(&app) else {
            return;
        };
        let Some(cl) = client() else {
            return;
        };
        let _ = cl
            .post(format!("{}/device/resolve", cfg.base))
            .bearer_auth(&cfg.token)
            .json(&serde_json::json!({ "agent_id": agent_id }))
            .send();
    });
}

#[derive(Deserialize)]
struct PendingReply {
    id: String,
    agent_id: String,
    reply_text: Option<String>,
    option_index: Option<i64>,
    text_mode: bool,
    options: Vec<String>,
}

#[derive(Clone, Serialize)]
struct RemoteReplyEvent {
    agent_id: String,
}

/// Turn a remote reply into the exact bytes to type into the agent's pty. This
/// mirrors the local `pickOption`: a numbered menu takes the digit; a free-text
/// (`text_mode`) choice takes the option's label.
fn format_reply(r: &PendingReply) -> String {
    if let Some(idx) = r.option_index {
        if r.text_mode && idx >= 1 && (idx as usize) <= r.options.len() {
            return format!("{}\r", r.options[(idx - 1) as usize]);
        }
        return format!("{idx}\r");
    }
    if let Some(t) = &r.reply_text {
        return format!("{t}\r");
    }
    String::new()
}

/// Background poller: applies replies the user made remotely. Runs for the life
/// of the app; a cheap no-op tick when remote control is off/unconfigured.
pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || {
        let mut interval = POLL_INTERVAL;
        loop {
            std::thread::sleep(interval);
            let Some(cfg) = current_config(&app) else {
                interval = POLL_INTERVAL; // unconfigured is a cheap no-op, not a failure
                continue;
            };
            let Some(cl) = client() else {
                continue;
            };
            let resp = cl
                .get(format!("{}/device/poll", cfg.base))
                .bearer_auth(&cfg.token)
                .send();
            let replies: Vec<PendingReply> = match resp {
                Ok(r) if r.status().is_success() => {
                    interval = POLL_INTERVAL; // reachable again — resume normal cadence
                    r.json().unwrap_or_default()
                }
                _ => {
                    interval = (interval * 2).min(POLL_MAX_INTERVAL);
                    continue;
                }
            };
            if replies.is_empty() {
                continue;
            }
            let sm = app.state::<SessionManager>();
            let mut applied: Vec<String> = Vec::new();
            for r in &replies {
                let data = format_reply(r);
                if !data.is_empty() {
                    // If the agent is gone, write_input errs — we still ack so the
                    // server stops redelivering a reply that can never land.
                    let _ = sm.write_input(&r.agent_id, &data);
                    let _ = app.emit(
                        "remote-reply",
                        RemoteReplyEvent {
                            agent_id: r.agent_id.clone(),
                        },
                    );
                }
                applied.push(r.id.clone());
            }
            let _ = cl
                .post(format!("{}/device/ack", cfg.base))
                .bearer_auth(&cfg.token)
                .json(&serde_json::json!({ "ids": applied }))
                .send();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_validation() {
        assert_eq!(validate_url("https://evor.dev/").unwrap(), "https://evor.dev");
        assert_eq!(
            validate_url("http://localhost:8787").unwrap(),
            "http://localhost:8787"
        );
        assert!(validate_url("http://evil.example").is_err()); // http non-local
        assert!(validate_url("ftp://evor.dev").is_err());
        assert!(validate_url("https://evor.dev/a b").is_err()); // whitespace
        assert!(validate_url("").is_err());
    }

    #[test]
    fn reply_formatting() {
        let menu = PendingReply {
            id: "n".into(),
            agent_id: "a".into(),
            reply_text: None,
            option_index: Some(2),
            text_mode: false,
            options: vec!["Yes".into(), "No".into()],
        };
        assert_eq!(format_reply(&menu), "2\r"); // numbered menu → digit

        let text_choice = PendingReply {
            id: "n".into(),
            agent_id: "a".into(),
            reply_text: None,
            option_index: Some(1),
            text_mode: true,
            options: vec!["main.rs".into()],
        };
        assert_eq!(format_reply(&text_choice), "main.rs\r"); // free-text → label

        let free = PendingReply {
            id: "n".into(),
            agent_id: "a".into(),
            reply_text: Some("do it".into()),
            option_index: None,
            text_mode: false,
            options: vec![],
        };
        assert_eq!(format_reply(&free), "do it\r");
    }
}
