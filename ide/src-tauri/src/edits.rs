//! Per-agent edit tracking. Each spawned coding agent logs the files it changes
//! to `<project>/.evoride/agents/<id>/edits.jsonl` (one JSON object per line),
//! driven by a managed skill block in CLAUDE.md/AGENTS.md plus the
//! `$EVORIDE_EDITS` env var injected into its pty. EvorIDE reads the log back to
//! show, per agent, which files that agent changed.

use serde::Serialize;
use std::path::Path;

/// A single tracked edit reported by an agent.
#[derive(Debug, Clone, Serialize)]
pub struct EditRecord {
    pub file: String,
    pub info: String,
}

const START: &str = "<!-- evoride:edits:start -->";
const END: &str = "<!-- evoride:edits:end -->";

/// The managed skill block instructing the agent to log its edits.
fn skill_block() -> String {
    format!(
        "{START}\n## Edit tracking (EvorIDE)\n\
         After you create or modify a file, append ONE json line to the file at the path in the \
         `$EVORIDE_EDITS` env var, recording what you changed:\n\
         `echo '{{\"file\":\"<repo-relative path>\",\"info\":\"<short what/why>\"}}' >> \"$EVORIDE_EDITS\"`\n\
         This lets EvorIDE show which files you changed in this session. Do it for every edit.\n{END}"
    )
}

/// Inject/refresh the managed skill block into CLAUDE.md and AGENTS.md
/// (idempotent — replaces a prior block, leaves other content intact).
pub fn ensure_skill(project: &str) -> Result<(), String> {
    write_block(project, "CLAUDE.md")?;
    write_block(project, "AGENTS.md")?;
    Ok(())
}

fn write_block(project: &str, file: &str) -> Result<(), String> {
    let p = Path::new(project).join(file);
    let existing = std::fs::read_to_string(&p).unwrap_or_default();
    let stripped = strip_block(&existing);
    let mut out = stripped.trim_end().to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&skill_block());
    out.push('\n');
    std::fs::write(&p, out).map_err(|e| e.to_string())
}

/// Remove the managed block (between markers) from `text`.
fn strip_block(text: &str) -> String {
    if let (Some(s), Some(e)) = (text.find(START), text.find(END)) {
        if e > s {
            let mut out = String::new();
            out.push_str(&text[..s]);
            out.push_str(&text[e + END.len()..]);
            return out;
        }
    }
    text.to_string()
}

/// Path to an agent's edits log.
pub fn edits_path(project: &str, agent_id: &str) -> std::path::PathBuf {
    Path::new(project)
        .join(".evoride")
        .join("agents")
        .join(agent_id)
        .join("edits.jsonl")
}

/// Unique-edited-file count per agent for the whole project (one cheap call for
/// the agent-row badges). Keyed by agent id.
pub fn edit_counts(project: &str) -> std::collections::HashMap<String, usize> {
    let mut out = std::collections::HashMap::new();
    let agents_dir = Path::new(project).join(".evoride").join("agents");
    if let Ok(rd) = std::fs::read_dir(&agents_dir) {
        for entry in rd.filter_map(|e| e.ok()) {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            let n = read_edits(project, &id).len();
            if n > 0 {
                out.insert(id, n);
            }
        }
    }
    out
}

/// Read an agent's edits log. Tolerates malformed lines (skipped) and dedupes by
/// `file`, keeping the LAST occurrence (latest info), newest first.
pub fn read_edits(project: &str, agent_id: &str) -> Vec<EditRecord> {
    let path = edits_path(project, agent_id);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };

    // Latest entry per file, preserving the order they were last seen.
    let mut order: Vec<String> = Vec::new();
    let mut latest: std::collections::HashMap<String, EditRecord> = std::collections::HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(file) = val.get("file").and_then(|v| v.as_str()) else {
            continue;
        };
        let file = file.trim();
        if file.is_empty() {
            continue;
        }
        let info = val
            .get("info")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if !latest.contains_key(file) {
            order.push(file.to_string());
        }
        latest.insert(
            file.to_string(),
            EditRecord {
                file: file.to_string(),
                info,
            },
        );
    }

    // Newest last-seen first.
    order
        .into_iter()
        .rev()
        .filter_map(|f| latest.remove(&f))
        .collect()
}
