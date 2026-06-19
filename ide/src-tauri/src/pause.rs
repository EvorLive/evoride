//! Per-project "pause" state: a manifest of everything that was suspended so the
//! Resume ("play") action can bring it all back. Like a graceful shutdown →
//! startup for a whole project — agents and long-running services alike.
//!
//! Stored at `~/.evoride/{project_id}/pause.json`, OUT of the repo (same home as
//! the AI run config). Its mere existence means the project is paused, so the
//! state survives an app restart.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One suspended thing — an AI agent (resumed in place) or a service (its `up`
/// command re-run). The id matches the live `AgentRecord`, so Resume just
/// re-launches that record.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PausedItem {
    pub id: String,
    pub title: String,
    pub command: String,
    #[serde(default)]
    pub cwd: String,
    /// "ai" (resume in place, send a continue signal) or "service" (re-run `up`).
    pub kind: String,
    /// The stop command that was run on pause, if any (e.g. `docker compose down`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub down: Option<String>,
}

/// Everything suspended for a project at pause time.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PauseManifest {
    /// Unix millis the project was paused (stamped by the UI).
    #[serde(default)]
    pub paused_at: i64,
    #[serde(default)]
    pub items: Vec<PausedItem>,
}

/// `~/.evoride/{project_id}/pause.json`. `project_id` is an app-generated id (no
/// path separators), so joining it under the home dir stays confined there.
fn pause_path(project_id: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(Path::new(&home).join(".evoride").join(project_id).join("pause.json"))
}

pub fn read(project_id: &str) -> Option<PauseManifest> {
    let text = std::fs::read_to_string(pause_path(project_id)?).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn write(project_id: &str, manifest: &PauseManifest) -> Result<(), String> {
    let p = pause_path(project_id).ok_or("no home dir")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| e.to_string())
}

pub fn clear(project_id: &str) {
    if let Some(p) = pause_path(project_id) {
        let _ = std::fs::remove_file(p);
    }
}

/// A project is paused iff its manifest exists.
pub fn is_paused(project_id: &str) -> bool {
    pause_path(project_id).map(|p| p.exists()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_read_clear_round_trip() {
        let _env = crate::env_lock();
        let home = std::env::temp_dir().join(format!("eterm-pause-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        // SAFETY: test-only; no other pause test depends on HOME concurrently.
        unsafe { std::env::set_var("HOME", &home) };
        let pid = "proj-pause-1";

        // Nothing paused yet.
        assert!(!is_paused(pid));
        assert!(read(pid).is_none());

        let manifest = PauseManifest {
            paused_at: 1_700_000_000_000,
            items: vec![
                PausedItem {
                    id: "a1".into(),
                    title: "claude".into(),
                    command: "claude".into(),
                    cwd: "/tmp/proj".into(),
                    kind: "ai".into(),
                    down: None,
                },
                PausedItem {
                    id: "s1".into(),
                    title: "stack".into(),
                    command: "docker compose up".into(),
                    cwd: "".into(),
                    kind: "service".into(),
                    down: Some("docker compose down".into()),
                },
            ],
        };
        write(pid, &manifest).unwrap();

        // Now paused, and the manifest reads back intact.
        assert!(is_paused(pid));
        let got = read(pid).unwrap();
        assert_eq!(got.paused_at, 1_700_000_000_000);
        assert_eq!(got.items.len(), 2);
        assert_eq!(got.items[0].kind, "ai");
        assert_eq!(got.items[1].down.as_deref(), Some("docker compose down"));

        // Clearing removes the manifest → no longer paused.
        clear(pid);
        assert!(!is_paused(pid));
        assert!(read(pid).is_none());

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn corrupt_manifest_reads_as_none() {
        let _env = crate::env_lock();
        let home = std::env::temp_dir().join(format!("eterm-pause-bad-{}", std::process::id()));
        let dir = home.join(".evoride").join("proj-bad");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pause.json"), "{ not valid json").unwrap();
        // SAFETY: test-only.
        unsafe { std::env::set_var("HOME", &home) };
        // is_paused is true (file exists) but read tolerates the garbage.
        assert!(is_paused("proj-bad"));
        assert!(read("proj-bad").is_none());
        let _ = std::fs::remove_dir_all(&home);
    }
}
