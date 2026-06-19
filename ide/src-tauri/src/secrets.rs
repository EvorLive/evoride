//! Per-machine secrets kept OUT of the repo at `~/.evoride/secrets.json`
//! (file mode 0600 on unix). Currently holds the Jira connection used by the
//! two-way task sync. Mirrors the per-machine `runinfo.json` convention.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Jira connection + mapping config.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JiraConfig {
    /// Site base, e.g. `https://acme.atlassian.net` (no trailing slash needed).
    pub base_url: String,
    /// Atlassian account email (the Basic-auth username).
    pub email: String,
    /// API token (https://id.atlassian.com/manage-profile/security/api-tokens).
    pub token: String,
    /// JQL selecting which issues to pull. Empty → a sensible default.
    #[serde(default)]
    pub jql: String,
    /// Map of Jira project KEY (e.g. "ENG") → EvorIDE project id. Issues whose
    /// project isn't mapped land in Unassigned ("").
    #[serde(default)]
    pub project_map: HashMap<String, String>,
}

impl JiraConfig {
    pub fn is_usable(&self) -> bool {
        !self.base_url.trim().is_empty()
            && !self.email.trim().is_empty()
            && !self.token.trim().is_empty()
    }
    /// JQL to use, falling back to "my open issues" when unset.
    pub fn effective_jql(&self) -> String {
        let j = self.jql.trim();
        if j.is_empty() {
            "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC".into()
        } else {
            j.to_string()
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Secrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    jira: Option<JiraConfig>,
    /// Per-device bearer token for the hosted Evor dashboard (evor.dev) remote
    /// control. Minted in the dashboard, pasted into Settings → Remote. Lives
    /// here (0600) so it's never returned to the webview.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    evor_token: Option<String>,
}

fn secrets_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(Path::new(&home).join(".evoride").join("secrets.json"))
}

fn read() -> Secrets {
    let Some(p) = secrets_path() else {
        return Secrets::default();
    };
    std::fs::read_to_string(p)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write(s: &Secrets) -> Result<(), String> {
    let path = secrets_path().ok_or("no home directory")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        // Create the file 0600 from the start so the API token is never even
        // briefly world-readable (the old write-then-chmod left a race window).
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| e.to_string())?;
        f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        // `mode` only applies on creation — tighten a pre-existing file too.
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&path, json).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The stored Jira config, if any.
pub fn load_jira() -> Option<JiraConfig> {
    read().jira.filter(|c| c.is_usable())
}

/// Persist (or clear) the Jira config.
pub fn save_jira(cfg: Option<JiraConfig>) -> Result<(), String> {
    let mut s = read();
    s.jira = cfg.filter(|c| c.is_usable());
    write(&s)
}

/// The stored Evor device token, if any (non-empty).
pub fn load_evor_token() -> Option<String> {
    read().evor_token.filter(|t| !t.trim().is_empty())
}

/// Whether a device token is stored — the only thing the UI may learn about it.
pub fn has_evor_token() -> bool {
    load_evor_token().is_some()
}

/// Persist (or clear, with `None`) the Evor device token.
pub fn save_evor_token(token: Option<String>) -> Result<(), String> {
    let mut s = read();
    s.evor_token = token.filter(|t| !t.trim().is_empty());
    write(&s)
}
