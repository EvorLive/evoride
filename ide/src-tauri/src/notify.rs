//! Native OS notifications for agent lifecycle events (desktop only).
//!
//! The in-app toast/inbox surface only helps when an Evor window is on screen.
//! When you've switched to another app — or another Evor window is covering this
//! one — a webview toast is invisible. This fires a real macOS/Windows
//! notification so "agent needs you" / "agent finished" reaches you regardless of
//! focus, and persists in the OS Notification Center.
//!
//! It is wired from [`crate::event::TauriSink`] — the single desktop event choke
//! point — so it fires exactly once per event no matter how many windows are
//! open (each window's in-app `NotificationCenter` would otherwise double up).
//! Best-effort throughout: a dropped notification must never panic a pty reader
//! thread (a panic in a backend thread is a DoS — see CLAUDE.md guardrail 8).

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

/// Ask the OS for notification permission once at startup. No-op if already
/// granted/denied; on dev (unsigned) macOS builds this may silently no-op.
pub fn request_permission(app: &AppHandle) {
    let _ = app.notification().request_permission();
}

/// Fire an OS notification for an `agent-waiting` / `pty-exit` event, but only
/// when NO Evor window is focused — if a window is up front, the in-app toast in
/// that window already covers it (and cross-window emit shows it in the others),
/// so an OS notification would just be noise. Resolves the agent title + project
/// name from the store for a human-readable body.
pub fn agent_event(app: &AppHandle, topic: &str, payload: &serde_json::Value) {
    // Any window focused → the user is looking at Evor; in-app toast suffices.
    let any_focused = app
        .webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false));
    if any_focused {
        return;
    }

    let id = payload.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let (title, body) = match topic {
        "agent-waiting" => {
            // Only the raise (waiting=true) is worth a notification; the matching
            // resolve (waiting=false) is silent.
            if !payload.get("waiting").and_then(|v| v.as_bool()).unwrap_or(false) {
                return;
            }
            let (name, project) = lookup(app, id);
            let q = payload
                .get("question")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let body = if q.is_empty() {
                format!("needs your input · {project}")
            } else {
                q.to_string()
            };
            (format!("{name} needs you"), body)
        }
        "pty-exit" => {
            let (name, project) = lookup(app, id);
            let err = payload
                .get("has_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let verb = if err { "exited with errors" } else { "finished" };
            (format!("{name} {verb}"), project)
        }
        _ => return,
    };

    let _ = app.notification().builder().title(title).body(body).show();
}

/// Resolve `(agent title, project name)` for an id; falls back to generic labels
/// so a missing record never blocks the notification.
fn lookup(app: &AppHandle, id: &str) -> (String, String) {
    if let Some(store) = app.try_state::<crate::store::Store>() {
        if let Some(a) = store.get_agent(id) {
            let project = store
                .get_project(&a.project_id)
                .map(|p| p.name)
                .unwrap_or_default();
            let title = if a.title.trim().is_empty() {
                "Agent".to_string()
            } else {
                a.title
            };
            return (title, project);
        }
    }
    ("Agent".to_string(), String::new())
}
