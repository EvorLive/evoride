//! Jira Cloud adapter for two-way task sync. Blocking `reqwest` (called from a
//! `spawn_blocking` so it never blocks the async runtime). Pull: JQL → issues →
//! tasks. Push: map a task's todo|doing|done back onto a Jira transition.
//!
//! Status mapping uses Jira's *status category* (stable across custom
//! workflows): `new` → todo, `indeterminate` → doing, `done` → done.

use crate::secrets::JiraConfig;
use base64::Engine;
use serde_json::Value;
use std::time::Duration;

/// One issue pulled from Jira, already normalized to our task vocabulary.
#[derive(Debug, Clone)]
pub struct JiraIssue {
    pub key: String,
    pub summary: String,
    pub status: String, // mapped: "todo" | "doing" | "done"
    /// The real Jira status name (e.g. "In Review", "Blocked").
    pub status_name: String,
    pub description: Option<String>,
    pub project_key: String,
    pub url: String,
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())
}

fn auth_header(cfg: &JiraConfig) -> String {
    let raw = format!("{}:{}", cfg.email.trim(), cfg.token.trim());
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(raw))
}

fn base(cfg: &JiraConfig) -> String {
    cfg.base_url.trim().trim_end_matches('/').to_string()
}

/// Map a Jira status category key → our status vocabulary.
fn status_from_category(key: &str) -> &'static str {
    match key {
        "done" => "done",
        "indeterminate" => "doing",
        _ => "todo", // "new" / unknown
    }
}

/// The status category we want when pushing a local status to Jira.
fn category_for_status(status: &str) -> &'static str {
    match status {
        "done" | "verified" => "done",
        "doing" => "indeterminate",
        _ => "new",
    }
}

/// Flatten an Atlassian Document Format (ADF) body to plain text (best-effort:
/// concatenates all `text` nodes, paragraph breaks as newlines).
fn adf_to_text(v: &Value) -> String {
    fn walk(v: &Value, out: &mut String) {
        match v {
            Value::Object(map) => {
                if map.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = map.get("text").and_then(|t| t.as_str()) {
                        out.push_str(t);
                    }
                }
                if let Some(content) = map.get("content").and_then(|c| c.as_array()) {
                    for c in content {
                        walk(c, out);
                    }
                    if map.get("type").and_then(|t| t.as_str()) == Some("paragraph") {
                        out.push('\n');
                    }
                }
            }
            Value::Array(arr) => {
                for c in arr {
                    walk(c, out);
                }
            }
            _ => {}
        }
    }
    let mut s = String::new();
    walk(v, &mut s);
    s.trim().to_string()
}

/// Normalize one raw Jira issue JSON object into our `JiraIssue`.
fn parse_issue(it: &Value, host: &str) -> Option<JiraIssue> {
    let key = it.get("key").and_then(|k| k.as_str()).unwrap_or("").to_string();
    if key.is_empty() {
        return None;
    }
    let f = it.get("fields").cloned().unwrap_or(Value::Null);
    let summary = f.get("summary").and_then(|s| s.as_str()).unwrap_or("").to_string();
    let status = f.get("status").cloned().unwrap_or(Value::Null);
    let cat = status
        .get("statusCategory")
        .and_then(|c| c.get("key"))
        .and_then(|k| k.as_str())
        .unwrap_or("new");
    let status_name = status.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
    let description = f.get("description").filter(|d| !d.is_null()).map(adf_to_text);
    let project_key = f
        .get("project")
        .and_then(|p| p.get("key"))
        .and_then(|k| k.as_str())
        .unwrap_or("")
        .to_string();
    Some(JiraIssue {
        url: format!("{host}/browse/{key}"),
        key,
        summary,
        status: status_from_category(cat).to_string(),
        status_name,
        description: description.filter(|d| !d.is_empty()),
        project_key,
    })
}

/// Pull issues matching the config's JQL (up to 100). Kept signature-stable for
/// existing callers; `fetch_top` is the bounded variant.
pub fn fetch_issues(cfg: &JiraConfig) -> Result<Vec<JiraIssue>, String> {
    fetch_top(cfg, 100)
}

/// Pull up to `limit` issues matching the config's JQL. Returns a clear error
/// string on auth/network failure so the UI can show it.
pub fn fetch_top(cfg: &JiraConfig, limit: u32) -> Result<Vec<JiraIssue>, String> {
    let c = client()?;
    let url = format!("{}/rest/api/3/search/jql", base(cfg));
    let body = serde_json::json!({
        "jql": cfg.effective_jql(),
        "maxResults": limit.max(1),
        "fields": ["summary", "status", "description", "project"],
    });
    let resp = c
        .post(&url)
        .header("Authorization", auth_header(cfg))
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .map_err(|e| format!("Jira request failed: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let text = resp.text().unwrap_or_default();
        return Err(format!("Jira {code}: {}", text.chars().take(300).collect::<String>()));
    }
    let json: Value = resp.json().map_err(|e| format!("Jira bad JSON: {e}"))?;
    let host = base(cfg);
    let out = json
        .get("issues")
        .and_then(|i| i.as_array())
        .map(|arr| arr.iter().filter_map(|it| parse_issue(it, &host)).collect())
        .unwrap_or_default();
    Ok(out)
}

/// Fetch a single issue by key (for importing just that one).
pub fn fetch_issue(cfg: &JiraConfig, key: &str) -> Result<JiraIssue, String> {
    let c = client()?;
    let url = format!(
        "{}/rest/api/3/issue/{}?fields=summary,status,description,project",
        base(cfg),
        key
    );
    let resp = c
        .get(&url)
        .header("Authorization", auth_header(cfg))
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("Jira request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Jira {}: couldn't read {key}", resp.status()));
    }
    let json: Value = resp.json().map_err(|e| format!("Jira bad JSON: {e}"))?;
    parse_issue(&json, &base(cfg)).ok_or_else(|| format!("Jira {key} had no usable fields"))
}

/// List the Jira projects the account can see, as `(key, name)` — for the
/// "which board?" picker when pushing a task up.
pub fn list_projects(cfg: &JiraConfig) -> Result<Vec<(String, String)>, String> {
    let c = client()?;
    let url = format!("{}/rest/api/3/project/search?maxResults=100", base(cfg));
    let resp = c
        .get(&url)
        .header("Authorization", auth_header(cfg))
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("Jira request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Jira {}: couldn't list projects", resp.status()));
    }
    let json: Value = resp.json().map_err(|e| format!("Jira bad JSON: {e}"))?;
    let out = json
        .get("values")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let key = p.get("key").and_then(|k| k.as_str())?.to_string();
                    let name = p.get("name").and_then(|n| n.as_str()).unwrap_or(&key).to_string();
                    Some((key, name))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(out)
}

/// Create a new Jira issue (used to push a local task UP to Jira). Returns the
/// new issue's `(key, browse_url)`.
pub fn create_issue(
    cfg: &JiraConfig,
    project_key: &str,
    summary: &str,
    description: Option<&str>,
) -> Result<(String, String), String> {
    let c = client()?;
    let url = format!("{}/rest/api/3/issue", base(cfg));
    // Description must be ADF; wrap plain text in a minimal document.
    let adf = description.filter(|d| !d.trim().is_empty()).map(|d| {
        serde_json::json!({
            "type": "doc",
            "version": 1,
            "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": d }] }]
        })
    });
    let mut fields = serde_json::json!({
        "project": { "key": project_key },
        "summary": summary,
        "issuetype": { "name": "Task" },
    });
    if let Some(adf) = adf {
        fields["description"] = adf;
    }
    let resp = c
        .post(&url)
        .header("Authorization", auth_header(cfg))
        .header("Accept", "application/json")
        .json(&serde_json::json!({ "fields": fields }))
        .send()
        .map_err(|e| format!("Jira create failed: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let text = resp.text().unwrap_or_default();
        return Err(format!("Jira {code}: {}", text.chars().take(300).collect::<String>()));
    }
    let json: Value = resp.json().map_err(|e| e.to_string())?;
    let key = json
        .get("key")
        .and_then(|k| k.as_str())
        .ok_or("Jira didn't return a new issue key")?
        .to_string();
    let browse = format!("{}/browse/{}", base(cfg), key);
    Ok((key, browse))
}

/// Push a local status onto a Jira issue by finding the transition whose target
/// status category matches and applying it. No-op (Ok) if the issue is already
/// in the desired category.
pub fn transition_issue(cfg: &JiraConfig, key: &str, status: &str) -> Result<(), String> {
    let c = client()?;
    let want = category_for_status(status);
    let list_url = format!("{}/rest/api/3/issue/{}/transitions", base(cfg), key);
    let resp = c
        .get(&list_url)
        .header("Authorization", auth_header(cfg))
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("Jira transitions failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Jira {}: cannot read transitions for {key}", resp.status()));
    }
    let json: Value = resp.json().map_err(|e| e.to_string())?;
    let transitions = json
        .get("transitions")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();

    let pick = transitions.iter().find(|t| {
        t.get("to")
            .and_then(|to| to.get("statusCategory"))
            .and_then(|c| c.get("key"))
            .and_then(|k| k.as_str())
            == Some(want)
    });
    let Some(tr) = pick else {
        // Nothing to do / no legal transition to that category — treat as no-op
        // rather than an error so a sync doesn't fail wholesale.
        return Ok(());
    };
    let id = tr.get("id").and_then(|i| i.as_str()).unwrap_or_default();
    if id.is_empty() {
        return Ok(());
    }
    let post_url = format!("{}/rest/api/3/issue/{}/transitions", base(cfg), key);
    let resp = c
        .post(&post_url)
        .header("Authorization", auth_header(cfg))
        .header("Accept", "application/json")
        .json(&serde_json::json!({ "transition": { "id": id } }))
        .send()
        .map_err(|e| format!("Jira transition apply failed: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let text = resp.text().unwrap_or_default();
        return Err(format!("Jira {code}: {}", text.chars().take(200).collect::<String>()));
    }
    Ok(())
}

/// One legal transition for an issue: the transition id, its name (e.g. "Start
/// Progress"), and the target status name (e.g. "In Progress") — enough for an
/// agent to map our lifecycle onto whatever workflow this board uses.
#[derive(Debug, Clone)]
pub struct Transition {
    pub id: String,
    pub name: String,
    pub to_status: String,
    pub to_category: String,
}

/// List the transitions currently available on an issue.
pub fn list_transitions(cfg: &JiraConfig, key: &str) -> Result<Vec<Transition>, String> {
    let c = client()?;
    let url = format!("{}/rest/api/3/issue/{}/transitions", base(cfg), key);
    let resp = c
        .get(&url)
        .header("Authorization", auth_header(cfg))
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("Jira transitions failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Jira {}: cannot read transitions for {key}", resp.status()));
    }
    let json: Value = resp.json().map_err(|e| e.to_string())?;
    let out = json
        .get("transitions")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    let id = t.get("id").and_then(|i| i.as_str())?.to_string();
                    let name = t.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                    let to = t.get("to");
                    let to_status = to
                        .and_then(|to| to.get("name"))
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string();
                    let to_category = to
                        .and_then(|to| to.get("statusCategory"))
                        .and_then(|c| c.get("key"))
                        .and_then(|k| k.as_str())
                        .unwrap_or("")
                        .to_string();
                    Some(Transition { id, name, to_status, to_category })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(out)
}

/// Apply a transition by its id.
pub fn apply_transition(cfg: &JiraConfig, key: &str, id: &str) -> Result<(), String> {
    let c = client()?;
    let url = format!("{}/rest/api/3/issue/{}/transitions", base(cfg), key);
    let resp = c
        .post(&url)
        .header("Authorization", auth_header(cfg))
        .header("Accept", "application/json")
        .json(&serde_json::json!({ "transition": { "id": id } }))
        .send()
        .map_err(|e| format!("Jira transition apply failed: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let text = resp.text().unwrap_or_default();
        return Err(format!("Jira {code}: {}", text.chars().take(200).collect::<String>()));
    }
    Ok(())
}

/// Post a comment on an issue (ADF wrapping a single paragraph).
pub fn add_comment(cfg: &JiraConfig, key: &str, body: &str) -> Result<(), String> {
    let c = client()?;
    let url = format!("{}/rest/api/3/issue/{}/comment", base(cfg), key);
    let adf = serde_json::json!({
        "body": {
            "type": "doc",
            "version": 1,
            "content": [{
                "type": "paragraph",
                "content": [{ "type": "text", "text": body }]
            }]
        }
    });
    let resp = c
        .post(&url)
        .header("Authorization", auth_header(cfg))
        .header("Accept", "application/json")
        .json(&adf)
        .send()
        .map_err(|e| format!("Jira comment failed: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let text = resp.text().unwrap_or_default();
        return Err(format!("Jira {code}: {}", text.chars().take(200).collect::<String>()));
    }
    Ok(())
}
