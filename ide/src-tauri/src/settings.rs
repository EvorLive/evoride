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
    /// Ids of bundled skills the user has turned off. Anything not listed stays
    /// at its default (auto-enabled), so new bundled skills opt in automatically.
    #[serde(default)]
    pub skills_disabled: Vec<String>,
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            daily_summary: true,
            skills_disabled: Vec::new(),
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

    /// Ids of skills the user has disabled.
    pub fn skills_disabled(&self) -> Vec<String> {
        self.data.lock().unwrap().skills_disabled.clone()
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
