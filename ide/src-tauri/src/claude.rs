//! Discover Claude Code's own saved sessions for a project directory.
//!
//! Claude Code stores sessions under `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`,
//! where the cwd is encoded by replacing `/` and `.` with `-`. Surfacing these
//! lets the IDE offer "continue this session" (`claude --resume <id>`) right when
//! a project opens — without the user remembering session ids.

use serde::Serialize;
use std::path::PathBuf;

use crate::fs::home;

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeSession {
    pub id: String,
    pub summary: String,
    /// File mtime, unix seconds.
    pub modified: i64,
    pub model: Option<String>,
}

/// Live-ish usage snapshot for the bottom status bar, read from the most
/// recently modified session file for this project.
#[derive(Debug, Clone, Serialize)]
pub struct ClaudeUsage {
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Approx context window fill (input vs ~200k), 0–100.
    pub context_pct: Option<f32>,
}

/// Path of the most recently modified session file for `cwd`.
pub fn newest_session_file(cwd: &str) -> Option<PathBuf> {
    let dir = sessions_dir(cwd)?;
    std::fs::read_dir(&dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jsonl"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .max_by_key(|(t, _)| *t)
        .map(|(_, p)| p)
}

/// What the user asked for in the newest session: a title + their prompts.
pub struct SessionIntent {
    pub id: String,
    pub title: Option<String>,
    pub prompts: Vec<String>,
}

/// Extract the user's intent (title + their actual prompts) from the newest
/// session — the basis for the derived intent-doc backstop.
pub fn session_intent(cwd: &str) -> Option<SessionIntent> {
    let path = newest_session_file(cwd)?;
    let id = path.file_stem()?.to_str()?.to_string();
    let bytes = std::fs::read(&path).ok()?;
    let text = String::from_utf8_lossy(&bytes);

    let mut title: Option<String> = None;
    let mut prompts: Vec<String> = Vec::new();
    for line in text.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if title.is_none() {
            if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                title = Some(t.to_string());
            }
        }
        if v.get("type").and_then(|t| t.as_str()) == Some("user") {
            if let Some(t) = extract_text(&v) {
                // Skip tool noise / reminders / slash output.
                if !t.starts_with('<') && !t.starts_with('[') && t.len() > 2 {
                    let line = truncate(&t, 200);
                    if !prompts.contains(&line) {
                        prompts.push(line);
                    }
                }
            }
        }
    }
    prompts.truncate(30);
    Some(SessionIntent { id, title, prompts })
}

/// Read usage from the newest session file in the project's Claude dir.
pub fn usage(cwd: &str) -> Option<ClaudeUsage> {
    let newest = newest_session_file(cwd)?;
    let bytes = std::fs::read(&newest).ok()?;
    // Only the tail matters for the latest usage.
    let start = bytes.len().saturating_sub(524_288);
    let tail = String::from_utf8_lossy(&bytes[start..]);

    let mut model: Option<String> = None;
    let mut input: u64 = 0;
    let mut output: u64 = 0;

    for line in tail.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some(msg) = v.get("message") else { continue };
        if let Some(m) = msg.get("model").and_then(|m| m.as_str()) {
            model = Some(m.to_string());
        }
        if let Some(u) = msg.get("usage") {
            let g = |k: &str| u.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
            // Latest assistant turn wins (tail order).
            input = g("input_tokens")
                + g("cache_read_input_tokens")
                + g("cache_creation_input_tokens");
            output = g("output_tokens");
        }
    }

    if model.is_none() && input == 0 && output == 0 {
        return None;
    }
    let context_pct = if input > 0 {
        Some((input as f32 / 200_000.0 * 100.0).min(100.0))
    } else {
        None
    };
    Some(ClaudeUsage {
        model,
        input_tokens: input,
        output_tokens: output,
        context_pct,
    })
}

/// Encode a working directory the way Claude Code names its project folder.
fn encode_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect()
}

fn sessions_dir(cwd: &str) -> Option<PathBuf> {
    let home = home()?;
    Some(
        PathBuf::from(home)
            .join(".claude")
            .join("projects")
            .join(encode_cwd(cwd)),
    )
}

/// List saved Claude sessions for `cwd`, newest first. Empty if none/unreadable.
pub fn list_sessions(cwd: &str) -> Vec<ClaudeSession> {
    let Some(dir) = sessions_dir(cwd) else {
        return Vec::new();
    };
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut out: Vec<ClaudeSession> = Vec::new();
    for entry in rd.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let modified = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let (summary, model) = scan_session(&path);
        out.push(ClaudeSession {
            id,
            summary,
            modified,
            model,
        });
    }

    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

/// Pull a human label + model from the head of a session file (best effort).
fn scan_session(path: &PathBuf) -> (String, Option<String>) {
    let Ok(bytes) = std::fs::read(path) else {
        return ("(session)".into(), None);
    };
    // Only the head is needed for a label/model.
    let head = &bytes[..bytes.len().min(131_072)];
    let text = String::from_utf8_lossy(head);

    let mut ai_title: Option<String> = None;
    let mut summary: Option<String> = None;
    let mut model: Option<String> = None;
    let mut first_user: Option<String> = None;

    for line in text.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if ai_title.is_none() {
            if let Some(s) = v.get("aiTitle").and_then(|s| s.as_str()) {
                ai_title = Some(s.to_string());
            }
        }
        if summary.is_none() {
            if let Some(s) = v.get("summary").and_then(|s| s.as_str()) {
                summary = Some(s.to_string());
            }
        }
        if model.is_none() {
            if let Some(m) = v
                .get("message")
                .and_then(|m| m.get("model"))
                .and_then(|m| m.as_str())
            {
                model = Some(m.to_string());
            }
        }
        if first_user.is_none() && v.get("type").and_then(|t| t.as_str()) == Some("user") {
            if let Some(text) = extract_text(&v) {
                first_user = Some(text);
            }
        }
        if ai_title.is_some() && model.is_some() {
            break;
        }
    }

    let label = ai_title
        .or(summary)
        .or(first_user)
        .map(|s| truncate(&s, 80))
        .unwrap_or_else(|| "(session)".into());
    (label, model)
}

/// Extract message text whether content is a string or an array of blocks.
fn extract_text(v: &serde_json::Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    if let Some(s) = content.as_str() {
        return Some(s.trim().to_string()).filter(|s| !s.is_empty());
    }
    if let Some(arr) = content.as_array() {
        for block in arr {
            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                if !t.trim().is_empty() {
                    return Some(t.trim().to_string());
                }
            }
        }
    }
    None
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.replace('\n', " ");
    if s.chars().count() <= max {
        s
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{t}…")
    }
}
