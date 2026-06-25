//! Per-agent task channel. An agent working a task reports progress by appending
//! JSON lines to the file at `$EVORIDE_TASKS` (one object per line), driven by a
//! managed skill block in CLAUDE.md/AGENTS.md. EvorIDE reads the log back and
//! reconciles the linked task's status and its breakdown steps — so the board
//! reflects what the agent is actually doing, and (later) syncs to Jira/Notion/
//! evor.live. Mirrors the edit-tracking mechanism in `edits.rs`.

use serde::Deserialize;
use std::path::{Path, PathBuf};

/// One progress report from an agent. All fields optional; the shape says what
/// it means:
///  - `{"new_task":"Add CSV export","description":"..."}` → create an EvorIDE task
///    for the current project (deduped by title) and make it the current task
///  - `{"status":"doing"}`                    → set the current task's status
///  - `{"step":"Write migration","status":"done"}` → set a step's status (match by id or title)
///  - `{"note":"..."}`                         → free-text progress note (appended to description)
#[derive(Debug, Clone, Deserialize)]
pub struct TaskUpdate {
    /// Title of a brand-new task the agent is about to start (auto-created).
    #[serde(default)]
    pub new_task: Option<String>,
    /// Optional longer description for a `new_task`.
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub step: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

const START: &str = "<!-- evoride:tasks:start -->";
const END: &str = "<!-- evoride:tasks:end -->";

/// The managed skill block instructing the agent to report task progress.
pub fn skill_block() -> String {
    format!(
        "{START}\n## Tasks (EvorIDE)\n\
         You have an `evor` CLI for THIS project's task board. Use it instead of \
         guessing — it keeps the board in sync with what you're actually doing.\n\
         - `evor task list` — what's open (add `--status todo` / `--json`). Run this \
         first if the user asks what to work on.\n\
         - `evor task new \"<short title>\" [--desc \"<what/why>\"]` — start NEW work \
         that isn't already listed. Creates the task, marks it in progress, and binds \
         it to THIS terminal. Add `--todo` to just queue it. Do this once per distinct \
         piece of work, before you start changing code; don't recreate an existing task.\n\
         - `evor task done` — finished the current task. `evor task start` — back to \
         in progress. `evor task block --note \"why\"` — stuck.\n\
         - `evor task note \"<text>\"` — progress note. \
         `evor task step done \"<step title>\"` — tick a breakdown step.\n\
         Report honestly and promptly. Do NOT create Jira (or other external) tickets \
         unless the user explicitly asks. Run `evor --help` for the full list.\n\
         (Fallback if `evor` is unavailable: append one JSON line to `$EVORIDE_TASKS`, \
         e.g. `echo '{{\"new_task\":\"…\"}}' >> \"$EVORIDE_TASKS\"`; \
         `{{\"status\":\"doing|done\"}}`; read `$EVORIDE_PROJECT_TASKS` to list.)\n{END}"
    )
}

/// Inject/refresh the managed task block into CLAUDE.md and AGENTS.md
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

/// Path to an agent's task-update log.
pub fn tasks_path(project: &str, agent_id: &str) -> PathBuf {
    Path::new(project)
        .join(".evoride")
        .join("agents")
        .join(agent_id)
        .join("tasks.jsonl")
}

/// Path to the read-only snapshot of THIS project's open tasks for an agent —
/// what `$EVORIDE_PROJECT_TASKS` points at (the "find task" channel).
pub fn project_tasks_path(project: &str, agent_id: &str) -> PathBuf {
    Path::new(project)
        .join(".evoride")
        .join("agents")
        .join(agent_id)
        .join("project-tasks.json")
}

/// Cursor file recording how many raw lines of an agent's task log we've already
/// processed — so creates/notes apply exactly once even though the log is
/// append-only and re-read on every poll.
fn cursor_path(project: &str, agent_id: &str) -> PathBuf {
    Path::new(project)
        .join(".evoride")
        .join("agents")
        .join(agent_id)
        .join("tasks.cursor")
}

fn read_cursor(project: &str, agent_id: &str) -> usize {
    std::fs::read_to_string(cursor_path(project, agent_id))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// Persist the new cursor (line count consumed).
pub fn write_cursor(project: &str, agent_id: &str, n: usize) {
    let path = cursor_path(project, agent_id);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, n.to_string());
}

/// Task updates an agent has reported since the last processed line, in order,
/// plus the new cursor (total raw line count) to persist after applying them.
/// Tolerates malformed lines (skipped, but still counted). Idempotent across
/// polls: already-consumed lines are never returned again.
pub fn read_updates_since(project: &str, agent_id: &str) -> (Vec<TaskUpdate>, usize) {
    let path = tasks_path(project, agent_id);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return (Vec::new(), read_cursor(project, agent_id)),
    };
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    let cursor = read_cursor(project, agent_id).min(total);
    let updates = lines[cursor..]
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str::<TaskUpdate>(l).ok())
        .filter(|u| {
            u.new_task.is_some() || u.status.is_some() || u.step.is_some() || u.note.is_some()
        })
        .collect();
    (updates, total)
}
