//! Global app settings persisted as JSON in the app data dir. Independent of any
//! project (e.g. whether daily summaries are generated on the Home view).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// Generate a daily activity summary on the Home view. Default ON.
    #[serde(default = "default_true")]
    pub daily_summary: bool,
    /// When a claude/codex agent hits a usage/session limit, auto-send "continue"
    /// once the limit resets so the task carries on unattended. Default ON.
    #[serde(default = "default_true")]
    pub auto_continue_rate_limit: bool,
    /// Ids of bundled skills the user has turned off. Anything not listed stays
    /// at its default (auto-enabled), so new bundled skills opt in automatically.
    #[serde(default)]
    pub skills_disabled: Vec<String>,
    /// Push agent-waiting notifications to the hosted Evor dashboard so they can
    /// be answered remotely. Default OFF (opt-in; needs a device token + URL).
    #[serde(default)]
    pub remote_enabled: bool,
    /// Base URL of the hosted dashboard, e.g. `https://evor.dev`. Empty until set.
    #[serde(default)]
    pub remote_url: String,
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            daily_summary: true,
            auto_continue_rate_limit: true,
            skills_disabled: Vec::new(),
            remote_enabled: false,
            remote_url: String::new(),
        }
    }
}

/// Managed handle to the settings file; created in `.setup` like `Store`.
pub struct SettingsStore {
    path: PathBuf,
    data: Mutex<Settings>,
}

impl SettingsStore {
    pub fn load(path: PathBuf) -> Self {
        let data: Settings = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            data: Mutex::new(data),
        }
    }

    fn save(&self, data: &Settings) {
        if let Ok(json) = serde_json::to_string_pretty(data) {
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }

    pub fn get(&self) -> Settings {
        self.data.lock().unwrap().clone()
    }

    pub fn set_daily_summary(&self, enabled: bool) -> Settings {
        let mut data = self.data.lock().unwrap();
        data.daily_summary = enabled;
        self.save(&data);
        data.clone()
    }

    pub fn set_auto_continue_rate_limit(&self, enabled: bool) -> Settings {
        let mut data = self.data.lock().unwrap();
        data.auto_continue_rate_limit = enabled;
        self.save(&data);
        data.clone()
    }

    /// Ids of skills the user has disabled.
    pub fn skills_disabled(&self) -> Vec<String> {
        self.data.lock().unwrap().skills_disabled.clone()
    }

    /// Set the remote dashboard URL + enabled flag together.
    pub fn set_remote(&self, url: String, enabled: bool) -> Settings {
        let mut data = self.data.lock().unwrap();
        data.remote_url = url;
        data.remote_enabled = enabled;
        self.save(&data);
        data.clone()
    }

    /// Record a skill as enabled (removed from the disabled list) or disabled.
    pub fn set_skill_disabled(&self, id: &str, disabled: bool) -> Settings {
        let mut data = self.data.lock().unwrap();
        data.skills_disabled.retain(|x| x != id);
        if disabled {
            data.skills_disabled.push(id.to_string());
        }
        self.save(&data);
        data.clone()
    }
}
