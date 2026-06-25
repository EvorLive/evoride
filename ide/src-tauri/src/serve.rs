//! Shared backend-over-HTTP logic for both transports that expose the IDE to a
//! browser: the standalone `evor-daemon` binary and the in-process server the
//! desktop app runs for "Mobile access" (so a phone shares the desktop's *live*
//! agents). Both build a [`Ctx`] of borrowed state and call [`dispatch`].
//!
//! SECURITY: every `path` arg is run through `guard::confine` before touching
//! disk, and every mutating git op holds the shared git lock — exactly as the
//! desktop `#[tauri::command]` wrappers do. New commands MUST preserve those
//! gates. Keeping ONE dispatcher means those gates can't drift between the
//! desktop app, the daemon, and the embedded mobile server.

use std::sync::Mutex;

use serde_json::Value;

use crate::event::Sink;
use crate::session::SessionManager;
use crate::settings::SettingsStore;
use crate::store::Store;
use crate::watch::WatchManager;
use crate::{claude, edits, fs as vfs, git, guard, run, tasktrack};

/// Borrowed handles to the backend state a command needs. The daemon builds this
/// from its owned `Arc`s; the embedded server builds it from the Tauri app's
/// managed state — so the SAME `SessionManager`/`Store` back both, which is what
/// makes a phone see (and drive) the desktop's running agents.
pub struct Ctx<'a> {
    pub store: &'a Store,
    pub settings: &'a SettingsStore,
    pub sessions: &'a SessionManager,
    pub git_lock: &'a Mutex<()>,
    pub watch_mgr: &'a WatchManager,
    pub sink: &'a Sink,
}

/// Map a command name + args to backend logic. Mirrors the desktop command
/// surface; `args` keys are camelCase (matching the frontend `invoke` calls).
pub fn dispatch(c: &Ctx, cmd: &str, a: &Value) -> Result<Value, String> {
    let ok = |v: Value| Ok(v);

    match cmd {
        // --- projects ---
        "list_projects" => to_value(c.store.list_projects()),
        "add_project" => {
            let p = c.store.add_project(&sarg(a, "path")?);
            crate::watch::sync(c.store, c.watch_mgr, c.sink.clone());
            to_value(p)
        }
        "remove_project" => {
            c.store.remove_project(&sarg(a, "id")?);
            crate::watch::sync(c.store, c.watch_mgr, c.sink.clone());
            ok(Value::Null)
        }
        "list_super_projects" => to_value(c.store.list_super_projects()),
        "create_super_project" => to_value(c.store.create_super_project(sarg(a, "name")?.trim())),
        "rename_super_project" => {
            c.store.rename_super_project(&sarg(a, "id")?, sarg(a, "name")?.trim());
            ok(Value::Null)
        }
        "delete_super_project" => {
            c.store.delete_super_project(&sarg(a, "id")?);
            ok(Value::Null)
        }
        "set_super_project_members" => {
            let ids = svec(a, "projectIds");
            c.store.set_super_project_members(&sarg(a, "id")?, &ids);
            ok(Value::Null)
        }

        // --- agents ---
        "list_agents" => to_value(c.store.list_agents(&sarg(a, "projectId")?)),
        "running_agents" => to_value(c.store.list_running()),
        "all_agents" => to_value(c.store.list_all()),
        "spawn_agent" => spawn_agent(c, a),
        "resume_agent" => resume_agent(c, a),
        "write_input" => {
            c.sessions.write_input(&sarg(a, "id")?, &sarg(a, "data")?)?;
            ok(Value::Null)
        }
        "resize_agent" => {
            c.sessions.resize(
                &sarg(a, "id")?,
                uarg(a, "rows").unwrap_or(24),
                uarg(a, "cols").unwrap_or(80),
            )?;
            ok(Value::Null)
        }
        "close_agent" => {
            c.sessions.close(&sarg(a, "id")?)?;
            ok(Value::Null)
        }
        "agent_scrollback" => {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD
                .encode(c.sessions.scrollback(&sarg(a, "id")?));
            ok(Value::String(b64))
        }
        "agent_size" => to_value(c.sessions.size(&sarg(a, "id")?)),

        // --- files (every path confined to an open project root) ---
        "read_dir" => to_value(vfs::read_dir(&confined(c, a)?)?),
        "read_file" => to_value(vfs::read_file(&confined(c, a)?)?),
        "write_file" => {
            vfs::write_file(&confined(c, a)?, &sarg(a, "content")?)?;
            ok(Value::Null)
        }
        "create_file" => {
            vfs::create_file(&confined(c, a)?)?;
            ok(Value::Null)
        }
        "list_files" => to_value(vfs::list_files(&confined(c, a)?)),

        // --- git ---
        "git_status" => to_value(git::status(&sarg(a, "cwd")?)),
        "git_changes" => to_value(git::changes(&sarg(a, "cwd")?)),
        "git_diff" => to_value(git::diff(&sarg(a, "cwd")?, osarg(a, "file").as_deref())),
        "git_branches" => to_value(git::branches(&sarg(a, "cwd")?)),
        "git_commit_push" => {
            let _g = c.git_lock.lock().unwrap();
            to_value(git::commit_and_push(&sarg(a, "cwd")?, &sarg(a, "message")?)?)
        }
        "git_fetch" => {
            let _g = c.git_lock.lock().unwrap();
            git::fetch(&sarg(a, "cwd")?)?;
            ok(Value::Null)
        }
        "git_pull" => {
            let _g = c.git_lock.lock().unwrap();
            to_value(git::pull(&sarg(a, "cwd")?)?)
        }
        "git_push" => {
            let _g = c.git_lock.lock().unwrap();
            to_value(git::push(&sarg(a, "cwd")?)?)
        }
        "git_checkout" => {
            let _g = c.git_lock.lock().unwrap();
            to_value(git::checkout(&sarg(a, "cwd")?, &sarg(a, "branch")?)?)
        }
        "git_create_branch" => {
            let _g = c.git_lock.lock().unwrap();
            to_value(git::create_branch(&sarg(a, "cwd")?, &sarg(a, "name")?)?)
        }

        // --- tasks (read) ---
        "list_tasks" => to_value(c.store.list_tasks(&sarg(a, "projectId")?)),
        "all_tasks" => to_value(c.store.list_all_tasks()),

        // --- tasks (agent CLI channel — `evor` binary, see localrpc.rs) ---
        // The open tasks for an agent's project, for `evor task list`.
        "agent_tasks" => {
            let agent_id = sarg(a, "agentId")?;
            let pid = c
                .store
                .get_agent(&agent_id)
                .map(|x| x.project_id)
                .ok_or("unknown agent")?;
            to_value(c.store.list_tasks(&pid))
        }
        // Reconcile an agent's appended task log NOW (so the UI updates live
        // instead of waiting for the next poll). Returns the touched tasks.
        "flush_agent_tasks" => {
            let agent_id = sarg(a, "agentId")?;
            let project_path = c
                .store
                .get_agent(&agent_id)
                .and_then(|x| c.store.get_project(&x.project_id))
                .map(|p| p.path)
                .ok_or("unknown agent/project")?;
            to_value(crate::apply_agent_tasks(c.store, &project_path, &agent_id))
        }

        // --- settings & misc ---
        "get_settings" => to_value(c.settings.get()),
        "claude_sessions" => to_value(claude::list_sessions(&sarg(a, "cwd")?)),
        "claude_usage" => to_value(claude::usage(&sarg(a, "cwd")?)),
        "run_config" => to_value(run::services_for(&sarg(a, "projectId")?, &sarg(a, "path")?)),
        "home_dir" => to_value(std::env::var_os("HOME").map(|h| h.to_string_lossy().into_owned())),

        // Window-only desktop commands have no meaning in a browser tab.
        "open_window" | "set_always_on_top" | "pop_out_terminal" | "popped_out"
        | "close_popout" => ok(Value::Null),

        other => Err(format!("command not bridged yet: {other}")),
    }
}

/// Confine a `path` arg to the open project roots (CLAUDE.md invariant #1).
fn confined(c: &Ctx, a: &Value) -> Result<String, String> {
    let roots = guard::project_roots(c.store);
    let p = guard::confine(&roots, &sarg(a, "path")?)?;
    Ok(p.to_string_lossy().to_string())
}

/// Spawn a new agent pty — mirrors the desktop `spawn_agent`, including the
/// subdir traversal guard, streaming output through `c.sink`.
fn spawn_agent(c: &Ctx, a: &Value) -> Result<Value, String> {
    let project_id = sarg(a, "projectId")?;
    let project = c.store.get_project(&project_id).ok_or("unknown project")?;

    let cwd = match osarg(a, "subdir").filter(|s| !s.trim().is_empty()) {
        Some(sub) => {
            let rel = std::path::Path::new(&sub);
            if rel.is_absolute()
                || rel.components().any(|x| matches!(x, std::path::Component::ParentDir))
            {
                return Err("invalid working directory".into());
            }
            std::path::Path::new(&project.path).join(rel).to_string_lossy().to_string()
        }
        None => project.path.clone(),
    };

    let command = if let Some(cmd) = osarg(a, "command").filter(|s| !s.trim().is_empty()) {
        cmd
    } else if let Some(src_id) = osarg(a, "resumeFrom") {
        let src = c.store.get_agent(&src_id).ok_or("unknown agent to resume")?;
        crate::resume_command(&src.command)
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    };

    let title = match osarg(a, "title") {
        Some(t) if !t.trim().is_empty() => t,
        _ => project.name.clone(),
    };

    let rec = c.store.add_agent(&project_id, &title, &command, &cwd);

    let _ = edits::ensure_skill(&project.path);
    let _ = tasktrack::ensure_skill(&project.path);
    let edits_path = edits::edits_path(&project.path, &rec.id);
    let tasks_path = tasktrack::tasks_path(&project.path, &rec.id);
    if let Some(dir) = edits_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let project_tasks_path =
        crate::write_project_tasks(c.store, &project.path, &project_id, &rec.id);

    c.sessions.spawn(
        c.sink.clone(),
        rec.id.clone(),
        title,
        cwd,
        command,
        edits_path.to_string_lossy().to_string(),
        tasks_path.to_string_lossy().to_string(),
        project_tasks_path,
        uarg(a, "rows").unwrap_or(24),
        uarg(a, "cols").unwrap_or(80),
    )?;
    serde_json::to_value(rec).map_err(|e| e.to_string())
}

/// Re-launch an existing agent in place — mirrors the desktop `resume_agent`.
fn resume_agent(c: &Ctx, a: &Value) -> Result<Value, String> {
    let id = sarg(a, "id")?;
    let rec = c.store.get_agent(&id).ok_or("unknown agent")?;
    let command = crate::resume_for(&rec.command);

    let _ = edits::ensure_skill(&rec.cwd);
    let _ = tasktrack::ensure_skill(&rec.cwd);
    let edits_path = edits::edits_path(&rec.cwd, &rec.id);
    let tasks_path = tasktrack::tasks_path(&rec.cwd, &rec.id);
    if let Some(dir) = edits_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let project_tasks_path =
        crate::write_project_tasks(c.store, &rec.cwd, &rec.project_id, &rec.id);

    c.sessions.spawn(
        c.sink.clone(),
        rec.id.clone(),
        rec.title.clone(),
        rec.cwd.clone(),
        command,
        edits_path.to_string_lossy().to_string(),
        tasks_path.to_string_lossy().to_string(),
        project_tasks_path,
        uarg(a, "rows").unwrap_or(24),
        uarg(a, "cols").unwrap_or(80),
    )?;
    c.store.set_agent_status(&id, "running");
    serde_json::to_value(rec).map_err(|e| e.to_string())
}

// --- arg helpers (camelCase keys, matching the frontend invoke calls) ---

fn to_value<T: serde::Serialize>(x: T) -> Result<Value, String> {
    serde_json::to_value(x).map_err(|e| e.to_string())
}

fn sarg(a: &Value, k: &str) -> Result<String, String> {
    a.get(k)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("missing arg: {k}"))
}

fn osarg(a: &Value, k: &str) -> Option<String> {
    a.get(k).and_then(Value::as_str).map(str::to_string)
}

fn uarg(a: &Value, k: &str) -> Option<u16> {
    a.get(k).and_then(Value::as_u64).map(|n| n as u16)
}

fn svec(a: &Value, k: &str) -> Vec<String> {
    a.get(k)
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

// --- shared auth/token helpers ---

/// Constant-time string compare (over SHA-256 digests, so length never leaks).
pub fn ct_eq(a: &str, b: &str) -> bool {
    use sha2::{Digest, Sha256};
    let ha = Sha256::digest(a.as_bytes());
    let hb = Sha256::digest(b.as_bytes());
    ha.iter().zip(hb.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A fresh random session token (hex).
pub fn gen_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// One WS event frame: `{"topic": "...", "payload": {...}}` as a JSON string.
pub fn frame(topic: &str, payload: &Value) -> String {
    serde_json::json!({ "topic": topic, "payload": payload }).to_string()
}
