//! `evor` — the EvorIDE task CLI, available on PATH inside every agent pty.
//!
//! ## Two modes (auto-detected)
//! * **Local mode** — when `EVORIDE_AGENT_ID` is set (i.e. running inside an
//!   EvorIDE-spawned terminal). Drives THIS project's task board: list/create/
//!   start/finish tasks, tick steps, log edits. Replaces the old
//!   `echo '{...}' >> $EVORIDE_TASKS` recipes with real subcommands.
//! * **Cloud mode** — otherwise. Delegates to the user's real cloud `evor` CLI
//!   found elsewhere on PATH, so the bundled binary never shadows it outside the
//!   IDE.
//!
//! ## How local mode talks to the IDE
//! Mutations append one JSON line to the SAME channels the IDE already ingests
//! (`$EVORIDE_TASKS`, `$EVORIDE_EDITS`) — the guaranteed-correct floor that works
//! even offline. When `EVORIDE_RPC` is present (the loopback server in
//! `localrpc.rs`), it then asks the IDE to reconcile immediately so the board
//! updates live; reads (`task list`) fetch fresh data the same way. Everything
//! still flows through the IDE's `serve::dispatch`, so the security gates hold.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

use serde_json::{Value, json};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Cloud mode: not inside an EvorIDE pty → hand off to the real cloud `evor`.
    if std::env::var_os("EVORIDE_AGENT_ID").is_none() {
        delegate_to_cloud(&args);
        return;
    }

    let rest: Vec<&str> = args.iter().map(String::as_str).collect();
    match rest.as_slice() {
        [] | ["-h"] | ["--help"] | ["help"] => print_usage(),
        ["task", sub @ ..] => task_cmd(sub),
        ["edit", sub @ ..] => edit_cmd(sub),
        [other, ..] => {
            eprintln!("evor: unknown command '{other}'. Run `evor --help`.");
            std::process::exit(2);
        }
    }
}

// ---------------------------------------------------------------------------
// `evor task …`
// ---------------------------------------------------------------------------

fn task_cmd(args: &[&str]) {
    match args {
        ["list", rest @ ..] => task_list(rest),
        ["new", rest @ ..] | ["add", rest @ ..] => task_new(rest),
        ["start", ..] | ["doing", ..] => {
            report(json!({ "status": "doing" }));
            println!("✓ marked current task in progress");
        }
        ["done", ..] | ["finish", ..] => {
            report(json!({ "status": "done" }));
            println!("✓ marked current task done");
        }
        ["block", rest @ ..] | ["blocked", rest @ ..] => {
            let note = flag(rest, "--note").or_else(|| positional(rest));
            let mut obj = json!({ "status": "todo" });
            if let Some(n) = note {
                obj["note"] = Value::String(n);
            }
            report(obj);
            println!("✓ marked current task blocked (back to todo)");
        }
        ["note", rest @ ..] => {
            let Some(text) = positional(rest) else {
                eprintln!("usage: evor task note \"<text>\"");
                std::process::exit(2);
            };
            report(json!({ "note": text }));
            println!("✓ note added");
        }
        ["step", rest @ ..] => task_step(rest),
        _ => {
            eprintln!("usage: evor task <list|new|start|done|block|note|step> …");
            std::process::exit(2);
        }
    }
}

fn task_list(args: &[&str]) {
    let want_json = args.contains(&"--json");
    let status = flag(args, "--status");

    let tasks = fetch_tasks();
    let filtered: Vec<&Value> = tasks
        .iter()
        .filter(|t| {
            status
                .as_deref()
                .map(|s| t.get("status").and_then(Value::as_str) == Some(s))
                .unwrap_or(true)
        })
        .collect();

    if want_json {
        println!("{}", serde_json::to_string_pretty(&filtered).unwrap_or_else(|_| "[]".into()));
        return;
    }
    if filtered.is_empty() {
        println!("No tasks.");
        return;
    }
    for t in filtered {
        let st = t.get("status").and_then(Value::as_str).unwrap_or("?");
        let title = t.get("title").and_then(Value::as_str).unwrap_or("(untitled)");
        let id = t.get("id").and_then(Value::as_str).unwrap_or("");
        let mark = match st {
            "done" => "✓",
            "doing" => "▶",
            _ => "○",
        };
        println!("{mark} [{st:<5}] {title}  ({id})");
    }
}

fn task_new(args: &[&str]) {
    let Some(title) = positional(args) else {
        eprintln!("usage: evor task new \"<title>\" [--desc \"…\"] [--todo]");
        std::process::exit(2);
    };
    let desc = flag(args, "--desc").or_else(|| flag(args, "--description"));
    let mut obj = json!({ "new_task": title });
    if let Some(d) = desc {
        obj["description"] = Value::String(d);
    }
    report(obj);
    // A new task defaults to `doing` (you're starting it now). `--todo` queues it
    // instead by following up with a status line.
    if args.contains(&"--todo") {
        report(json!({ "status": "todo" }));
        println!("✓ created task (queued as todo)");
    } else {
        println!("✓ created task and started working on it");
    }
}

fn task_step(args: &[&str]) {
    // `evor task step done "<title>"`  or  `evor task step "<title>" [--status done]`
    let (status, title) = match args {
        ["done", rest @ ..] => ("done".to_string(), positional(rest)),
        ["todo", rest @ ..] => ("todo".to_string(), positional(rest)),
        ["doing", rest @ ..] => ("doing".to_string(), positional(rest)),
        rest => (flag(rest, "--status").unwrap_or_else(|| "done".into()), positional(rest)),
    };
    let Some(title) = title else {
        eprintln!("usage: evor task step done \"<step title>\"");
        std::process::exit(2);
    };
    report(json!({ "step": title, "status": status }));
    println!("✓ step '{title}' → {status}");
}

// ---------------------------------------------------------------------------
// `evor edit <file> [--info "…"]`
// ---------------------------------------------------------------------------

fn edit_cmd(args: &[&str]) {
    let Some(file) = positional(args) else {
        eprintln!("usage: evor edit <repo-relative path> [--info \"what/why\"]");
        std::process::exit(2);
    };
    let info = flag(args, "--info").unwrap_or_default();
    let line = json!({ "file": file, "info": info }).to_string();
    if append_env_file("EVORIDE_EDITS", &line) {
        println!("✓ logged edit: {file}");
    } else {
        eprintln!("evor: EVORIDE_EDITS not set — not inside an EvorIDE session?");
        std::process::exit(1);
    }
}

// ---------------------------------------------------------------------------
// Channels: JSONL append (floor) + RPC reconcile (live)
// ---------------------------------------------------------------------------

/// Append one task-update line to `$EVORIDE_TASKS`, then ask the IDE to
/// reconcile now (if the loopback RPC is up) so the board updates live.
fn report(obj: Value) {
    let line = obj.to_string();
    if !append_env_file("EVORIDE_TASKS", &line) {
        eprintln!("evor: EVORIDE_TASKS not set — not inside an EvorIDE session?");
        std::process::exit(1);
    }
    if let Some(id) = std::env::var("EVORIDE_AGENT_ID").ok() {
        let _ = rpc("flush_agent_tasks", json!({ "agentId": id }));
    }
}

/// The agent's project tasks — fresh via RPC when available, else the on-disk
/// snapshot at `$EVORIDE_PROJECT_TASKS`.
fn fetch_tasks() -> Vec<Value> {
    if let Ok(id) = std::env::var("EVORIDE_AGENT_ID") {
        if let Some(data) = rpc("agent_tasks", json!({ "agentId": id })) {
            if let Some(arr) = data.as_array() {
                return arr.clone();
            }
        }
    }
    // Fallback: the read-only snapshot file.
    if let Some(path) = std::env::var_os("EVORIDE_PROJECT_TASKS") {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(&text) {
                return arr;
            }
        }
    }
    Vec::new()
}

/// POST `{cmd, args}` to the loopback RPC. Returns the `data` payload on success,
/// `None` if the RPC is absent/unreachable or the command failed (callers then
/// rely on the JSONL floor / snapshot).
fn rpc(cmd: &str, args: Value) -> Option<Value> {
    let url = std::env::var("EVORIDE_RPC").ok()?;
    let token = std::env::var("EVORIDE_RPC_TOKEN").ok()?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?;
    let resp = client
        .post(format!("{url}/rpc"))
        .bearer_auth(token)
        .json(&json!({ "cmd": cmd, "args": args }))
        .send()
        .ok()?;
    let body: Value = resp.json().ok()?;
    if body.get("ok").and_then(Value::as_bool) == Some(true) {
        Some(body.get("data").cloned().unwrap_or(Value::Null))
    } else {
        None
    }
}

/// Append a line to the file named by an env var (creating it if needed).
/// Returns false if the env var is unset.
fn append_env_file(var: &str, line: &str) -> bool {
    let Some(path) = std::env::var_os(var) else {
        return false;
    };
    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => {
            let _ = writeln!(f, "{line}");
            true
        }
        Err(e) => {
            eprintln!("evor: cannot write {}: {e}", PathBuf::from(path).display());
            false
        }
    }
}

// ---------------------------------------------------------------------------
// Cloud-mode passthrough
// ---------------------------------------------------------------------------

/// Outside an EvorIDE pty, hand off to the user's real cloud `evor` binary — the
/// next `evor` on PATH that isn't this one. Keeps the bundled binary from
/// shadowing the cloud CLI for normal shell use.
fn delegate_to_cloud(args: &[String]) {
    match find_other_evor() {
        Some(bin) => {
            let status = Command::new(&bin).args(args).status();
            match status {
                Ok(s) => std::process::exit(s.code().unwrap_or(1)),
                Err(e) => {
                    eprintln!("evor: failed to run {}: {e}", bin.display());
                    std::process::exit(1);
                }
            }
        }
        None => {
            eprintln!(
                "evor: this is the EvorIDE task CLI, meant to run inside an EvorIDE\n\
                 terminal. No cloud `evor` was found on PATH. Inside the IDE, try\n\
                 `evor task list`."
            );
            std::process::exit(1);
        }
    }
}

/// The first `evor` on PATH whose path differs from this running binary.
fn find_other_evor() -> Option<PathBuf> {
    let me = std::env::current_exe().ok().and_then(|p| p.canonicalize().ok());
    let exe_name = if cfg!(windows) { "evor.exe" } else { "evor" };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(exe_name);
        if !cand.is_file() {
            continue;
        }
        let canon = cand.canonicalize().ok();
        if canon.is_some() && canon == me {
            continue; // that's us
        }
        return Some(cand);
    }
    None
}

// ---------------------------------------------------------------------------
// Tiny arg helpers
// ---------------------------------------------------------------------------

/// Value following `name` (e.g. `--desc foo` → "foo").
fn flag(args: &[&str], name: &str) -> Option<String> {
    args.iter().position(|a| *a == name).and_then(|i| args.get(i + 1)).map(|s| s.to_string())
}

/// First argument that isn't a flag or a flag's value.
fn positional(args: &[&str]) -> Option<String> {
    let mut skip_next = false;
    for a in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if a.starts_with("--") {
            skip_next = true; // assume it takes a value; bare flags handled by callers
            continue;
        }
        return Some(a.to_string());
    }
    None
}

fn print_usage() {
    println!(
        "evor — EvorIDE task CLI (runs inside an EvorIDE terminal)\n\n\
         TASKS\n  \
         evor task list [--status todo|doing|done] [--json]\n  \
         evor task new \"<title>\" [--desc \"…\"] [--todo]\n  \
         evor task start                 mark the current task in progress\n  \
         evor task done                  mark the current task done\n  \
         evor task block [--note \"…\"]    send the current task back to todo\n  \
         evor task note \"<text>\"         add a progress note\n  \
         evor task step done \"<title>\"   tick a breakdown step\n\n\
         EDITS\n  \
         evor edit <path> [--info \"what/why\"]   log a file you changed\n\n\
         New tasks start as `doing` and bind to this terminal; use --todo to queue.\n"
    );
}
