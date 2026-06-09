//! Multi-agent pty session manager for the IDE.
//!
//! Each "agent" is a real pty (a shell, `claude`, `codex`, …) running in its own
//! working directory. Output is streamed to the frontend as base64 over a Tauri
//! event; xterm.js in each tile handles the terminal emulation. This keeps the
//! backend thin — it pipes bytes and tracks process liveness.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Per-session scrollback cap so a discarded tile can be restored on return.
const SCROLLBACK_CAP: usize = 512 * 1024;

/// Public, serializable description of an agent session.
#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub command: String,
    pub running: bool,
}

/// Payload for the `pty-output` event.
#[derive(Clone, Serialize)]
struct OutputEvent {
    id: String,
    /// base64-encoded raw pty bytes.
    data: String,
}

/// Payload for the `pty-exit` event — includes issue detection for "fix this".
#[derive(Clone, Serialize)]
struct ExitEvent {
    id: String,
    /// True if the output contained a failure signature.
    has_error: bool,
    /// Tail of recent output, used as fix context.
    context: String,
}

/// Payload for the `agent-waiting` event (blocking on user input).
#[derive(Clone, Serialize)]
struct WaitingEvent {
    id: String,
    waiting: bool,
    /// Labels of a numbered select menu (1-based); empty for y/n or free-text.
    options: Vec<String>,
    /// The question the agent is asking (so the UI shows *what* it wants).
    question: String,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Recent output, so a discarded (Chrome-style) tile can be restored.
    scrollback: Arc<Mutex<Vec<u8>>>,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, Session>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a new agent pty (with a caller-supplied id, so it matches the
    /// store record) and start streaming its output to the frontend.
    pub fn spawn(
        &self,
        app: AppHandle,
        id: String,
        title: String,
        cwd: String,
        command: String,
        edits_path: String,
        tasks_path: String,
        project_tasks_path: String,
        rows: u16,
        cols: u16,
    ) -> Result<AgentInfo, String> {
        // Validate up front: a missing CLI (e.g. `claude` not on PATH in a
        // packaged app) should fail with a clear message, not a dead terminal.
        let program = command.split_whitespace().next().unwrap_or_default();
        if !program.is_empty() && resolve_program(program).is_none() {
            return Err(format!(
                "'{program}' not found. Set its path in Settings → Agents, or install it and reopen."
            ));
        }
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty: {e}"))?;

        let mut cmd = build_command(&command);
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        // Per-agent edit tracking: the agent's id + where to log files it edits.
        cmd.env("EVORIDE_AGENT_ID", &id);
        cmd.env("EVORIDE_EDITS", &edits_path);
        // Per-agent task channel: where the agent reports task/step status.
        cmd.env("EVORIDE_TASKS", &tasks_path);
        // Read-only: the open tasks for THIS project, so the agent can find what
        // to work on (a JSON snapshot EvorIDE refreshes on spawn/resume).
        cmd.env("EVORIDE_PROJECT_TASKS", &project_tasks_path);

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn: {e}"))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("writer: {e}"))?;

        // Reader thread: pump pty output to the frontend until EOF.
        let scrollback = Arc::new(Mutex::new(Vec::<u8>::new()));
        let ev_id = id.clone();
        let ev_app = app.clone();
        let sb = scrollback.clone();
        std::thread::spawn(move || {
            // Rolling tail (shared eterm-core) for issue detection on exit.
            let mut tail = eterm_core::OutputTail::new(8192);
            let mut waiting = false;
            let mut options: Vec<String> = Vec::new();
            let mut question = String::new();
            // Prompt detection is the per-chunk hot path; during a burst of output
            // (a build, a log dump) re-running it on every 8KB chunk throttles the
            // reader and makes the terminal feel laggy. Rate-limit it — a prompt
            // lands when output *settles*, so ~120ms resolution is imperceptible.
            let mut last_detect = Instant::now()
                .checked_sub(Duration::from_secs(1))
                .unwrap_or_else(Instant::now);
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        tail.push(&buf[..n]);
                        // Detect blocking-on-input transitions (+ parsed menu
                        // choices) for the rail, agent list, and home summary.
                        if last_detect.elapsed() >= Duration::from_millis(80) {
                            last_detect = Instant::now();
                            let info = eterm_core::detect_prompt(tail.text());
                            let now_waiting = info.is_some();
                            let (now_options, now_question) = info
                                .map(|i| (i.options, i.question))
                                .unwrap_or_default();
                            if now_waiting != waiting
                                || now_options != options
                                || now_question != question
                            {
                                waiting = now_waiting;
                                options = now_options.clone();
                                question = now_question.clone();
                                let _ = ev_app.emit(
                                    "agent-waiting",
                                    WaitingEvent {
                                        id: ev_id.clone(),
                                        waiting,
                                        options: now_options,
                                        question: now_question,
                                    },
                                );
                            }
                        }
                        {
                            let mut s = sb.lock().unwrap();
                            s.extend_from_slice(&buf[..n]);
                            let len = s.len();
                            if len > SCROLLBACK_CAP {
                                s.drain(0..len - SCROLLBACK_CAP);
                            }
                        }
                        let data = B64.encode(&buf[..n]);
                        let _ = ev_app.emit(
                            "pty-output",
                            OutputEvent {
                                id: ev_id.clone(),
                                data,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
            let _ = ev_app.emit(
                "agent-waiting",
                WaitingEvent {
                    id: ev_id.clone(),
                    waiting: false,
                    options: Vec::new(),
                    question: String::new(),
                },
            );
            let _ = ev_app.emit(
                "pty-exit",
                ExitEvent {
                    id: ev_id,
                    has_error: tail.has_error(),
                    context: tail.text().to_string(),
                },
            );
        });

        let info = AgentInfo {
            id: id.clone(),
            title,
            cwd,
            command,
            running: true,
        };

        let session = Session {
            master: pair.master,
            writer,
            child,
            scrollback,
        };
        self.sessions.lock().unwrap().insert(id, session);
        Ok(info)
    }

    pub fn write_input(&self, id: &str, data: &str) -> Result<(), String> {
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(id).ok_or("no such agent")?;
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        s.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(id).ok_or("no such agent")?;
        s.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        if let Some(mut s) = self.sessions.lock().unwrap().remove(id) {
            let _ = s.child.kill();
        }
        Ok(())
    }

    /// Snapshot of a session's scrollback for restoring a discarded tile.
    pub fn scrollback(&self, id: &str) -> Vec<u8> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .map(|s| s.scrollback.lock().unwrap().clone())
            .unwrap_or_default()
    }

    /// Kill every running agent — used on app exit so no pty/service is orphaned.
    pub fn kill_all(&self) {
        let mut map = self.sessions.lock().unwrap();
        for s in map.values_mut() {
            let _ = s.child.kill();
        }
        map.clear();
    }
}

/// Split a command string into program + args (whitespace-naive, good enough
/// for `claude`, `codex`, or a bare shell; quote-aware parsing can come later).
fn build_command(command: &str) -> CommandBuilder {
    let mut parts = command.split_whitespace();
    let program = parts.next().unwrap_or("/bin/sh");
    let mut cmd = CommandBuilder::new(program);
    for arg in parts {
        cmd.arg(arg);
    }
    cmd
}

#[cfg(windows)]
const EXE_EXTS: &[&str] = &["", ".exe", ".cmd", ".bat"];
#[cfg(not(windows))]
const EXE_EXTS: &[&str] = &[""];

/// Resolve a program to an absolute path: honor an explicit path (containing a
/// separator), otherwise search PATH (with Windows executable extensions).
/// Returns `None` when it can't be found — so spawning can fail with a clear
/// message instead of a silent dead terminal.
pub fn resolve_program(program: &str) -> Option<String> {
    let has_sep = program.contains('/') || program.contains('\\');
    if has_sep {
        for ext in EXE_EXTS {
            let cand = format!("{program}{ext}");
            if std::path::Path::new(&cand).is_file() {
                return Some(cand);
            }
        }
        return None;
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for ext in EXE_EXTS {
            let cand = dir.join(format!("{program}{ext}"));
            if cand.is_file() {
                return Some(cand.to_string_lossy().into_owned());
            }
        }
    }
    None
}
