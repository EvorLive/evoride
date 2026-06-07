//! eterm IDE — a project-centric Tauri desktop shell. Projects collect their
//! agents in one place; agents (live + history) are persisted so they can be
//! resumed; tasks track the plan per project.

mod claude;
mod edits;
mod fs;
mod git;
mod intent;
mod run;
mod session;
mod settings;
mod store;
mod summary;

use claude::{ClaudeSession, ClaudeUsage};
use edits::EditRecord;
use intent::IntentConfig;
use fs::{FileContent, FileEntry};
use git::{FileChange, GitStatus};
use run::Service;
use session::SessionManager;
use settings::{Settings, SettingsStore};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use store::{AgentRecord, Project, Store, Task};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

/// Serializes mutating git operations so concurrent pulls/commits/pushes across
/// windows or buttons don't clobber each other.
#[derive(Default)]
struct GitLock(Mutex<()>);

static WINDOW_SEQ: AtomicU64 = AtomicU64::new(1);

/// Open another IDE window in the same process. State (Store, ptys) is shared,
/// so multiple windows coexist safely; each picks its own project.
#[tauri::command]
fn open_window(app: AppHandle) -> Result<(), String> {
    let n = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("w-{n}");
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("EvorIde")
        .inner_size(1280.0, 820.0)
        .maximized(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// --- projects ---

#[tauri::command]
fn add_project(store: State<Store>, path: String) -> Project {
    store.add_project(&path)
}

#[tauri::command]
fn list_projects(store: State<Store>) -> Vec<Project> {
    store.list_projects()
}

#[tauri::command]
fn remove_project(store: State<Store>, id: String) {
    store.remove_project(&id)
}

// --- agents ---

/// Append the agent's own continue flag when resuming, so e.g. Claude Code picks
/// up its prior session instead of starting cold.
fn resume_command(command: &str) -> String {
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
fn resume_for(command: &str) -> String {
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

    // Resolve the working dir — a service may run in a monorepo subdir.
    let cwd = match subdir.filter(|s| !s.trim().is_empty()) {
        Some(sub) => std::path::Path::new(&project.path)
            .join(sub)
            .to_string_lossy()
            .to_string(),
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

    // Per-agent edit tracking: managed skill block + log path for this agent.
    let _ = edits::ensure_skill(&project.path);
    let edits_path = edits::edits_path(&project.path, &rec.id);
    if let Some(dir) = edits_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }

    manager.spawn(
        app,
        rec.id.clone(),
        title,
        cwd,
        command,
        edits_path.to_string_lossy().to_string(),
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
    let edits_path = edits::edits_path(&project_root, &rec.id);
    if let Some(dir) = edits_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }

    manager.spawn(
        app,
        rec.id.clone(),
        rec.title.clone(),
        rec.cwd.clone(),
        command,
        edits_path.to_string_lossy().to_string(),
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

/// Base64 scrollback for restoring a discarded (background) terminal.
#[tauri::command]
fn agent_scrollback(manager: State<SessionManager>, id: String) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(manager.scrollback(&id))
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

// --- tasks ---

#[tauri::command]
fn list_tasks(store: State<Store>, project_id: String) -> Vec<Task> {
    store.list_tasks(&project_id)
}

#[tauri::command]
fn add_task(
    store: State<Store>,
    project_id: String,
    title: String,
    agent_id: Option<String>,
) -> Task {
    store.add_task(&project_id, &title, agent_id)
}

#[tauri::command]
fn update_task(store: State<Store>, id: String, status: String) {
    store.update_task(&id, &status)
}

#[tauri::command]
fn delete_task(store: State<Store>, id: String) {
    store.delete_task(&id)
}

// --- files ---

#[tauri::command]
fn read_dir(path: String) -> Result<Vec<FileEntry>, String> {
    fs::read_dir(&path)
}

#[tauri::command]
fn read_file(path: String) -> Result<FileContent, String> {
    fs::read_file(&path)
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

// --- run config ---

#[tauri::command]
fn run_config(path: String) -> Vec<Service> {
    run::read_config(&path)
}

#[tauri::command]
fn create_run_config(path: String) -> Result<Vec<Service>, String> {
    run::create_config(&path)
}

// --- intent docs ---

#[tauri::command]
fn intent_config(path: String) -> IntentConfig {
    intent::read_config(&path)
}

#[tauri::command]
fn set_intent(path: String, enabled: bool, mode: String) -> Result<IntentConfig, String> {
    intent::set_enabled(&path, enabled, &mode)
}

#[tauri::command]
fn read_intent(path: String) -> String {
    intent::read_doc(&path)
}

#[tauri::command]
fn update_intent(path: String) -> Result<String, String> {
    intent::update(&path)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionManager::new())
        .manage(GitLock::default())
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .expect("app data dir");
            std::fs::create_dir_all(&dir).ok();
            app.manage(Store::load(dir.join("eterm-ide.json")));
            app.manage(SettingsStore::load(dir.join("settings.json")));

            // Native window menu. File: Open Project / New Window / Home / Quit,
            // plus an Edit submenu (predefined items) so macOS shortcuts work.
            let open_project = MenuItemBuilder::with_id("open-project", "Open Project…").build(app)?;
            let new_window = MenuItemBuilder::with_id("new-window", "New Window").build(app)?;
            let home = MenuItemBuilder::with_id("home", "Home").build(app)?;
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&open_project)
                .item(&new_window)
                .item(&home)
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
            list_agents,
            running_agents,
            spawn_agent,
            resume_agent,
            write_input,
            resize_agent,
            close_agent,
            mark_agent_exited,
            agent_scrollback,
            archive_agent,
            delete_agent,
            list_tasks,
            add_task,
            update_task,
            delete_task,
            read_dir,
            read_file,
            claude_sessions,
            claude_usage,
            git_status,
            git_changes,
            git_diff,
            git_commit_push,
            git_fetch,
            git_pull,
            git_push,
            run_config,
            create_run_config,
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
            daily_summary,
            summary_dates,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // On exit, kill every running agent so no pty/service is orphaned.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app_handle.state::<SessionManager>().kill_all();
            }
        });
}
