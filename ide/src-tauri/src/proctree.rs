//! Detect what's actually running UNDER a pty — the terminal "parent" shell (or
//! agent) and its descendant processes. A project PAUSE uses this to tear down a
//! stack a user (or an agent) started *interactively* by typing into a shell —
//! e.g. `docker compose up` or `tilt up` — not just the services declared in the
//! run config. We read the process table once (`ps` on Unix), walk the ppid
//! graph down from the pty's child pid, and map any `up`-style launcher to its
//! teardown command.
//!
//! The pid-walk + command matching are pure functions so they're unit-tested
//! without spawning anything; only `running_under` touches the OS.

use serde::Serialize;
use std::collections::HashSet;

/// A row from the process table.
#[derive(Debug, Clone)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub args: String,
}

/// A long-running stack detected under a terminal, with how to stop it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DetectedStack {
    /// Human label, e.g. "docker compose".
    pub label: String,
    /// The teardown command to run on pause, e.g. "docker compose down".
    pub down: String,
    /// The matching process's command line (so the UI can show what it found).
    pub command: String,
    pub pid: u32,
}

/// Parse `ps -axo pid=,ppid=,args=` output: two leading integer columns, then the
/// full command line. Tolerant of leading padding and odd lines (skips them).
pub fn parse_ps(text: &str) -> Vec<Proc> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (it.next(), it.next()) else {
            continue;
        };
        let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) else {
            continue;
        };
        // Everything after the first two whitespace-separated tokens is the args.
        let args = it.collect::<Vec<_>>().join(" ");
        out.push(Proc { pid, ppid, args });
    }
    out
}

/// The set of `root` plus every transitive descendant pid in the ppid graph.
pub fn descendant_pids(procs: &[Proc], root: u32) -> HashSet<u32> {
    let mut set = HashSet::new();
    set.insert(root);
    // Fixed-point: keep adding children of known pids until nothing new appears.
    loop {
        let mut grew = false;
        for p in procs {
            if set.contains(&p.ppid) && set.insert(p.pid) {
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    set
}

/// Map a command line to a (label, teardown) pair when it's an `up`-style
/// launcher worth tearing down. Compares basenames so an absolute program path
/// (`/usr/local/bin/docker compose up`) still matches. Returns `None` for plain
/// dev servers (stopped by killing the process) and for non-`up` invocations
/// (`docker compose ps`, `docker compose down`).
pub fn down_for(args: &str) -> Option<(String, String)> {
    let toks: Vec<String> = args
        .split_whitespace()
        .map(|t| t.rsplit(['/', '\\']).next().unwrap_or(t).to_lowercase())
        .collect();
    let first = toks.first().map(String::as_str);
    let second = toks.get(1).map(String::as_str);
    let has = |w: &str| toks.iter().any(|t| t == w);

    // tilt up
    if first == Some("tilt") && has("up") {
        return Some(("tilt".into(), "tilt down".into()));
    }
    // docker / podman compose up [...]
    if matches!(first, Some("docker") | Some("podman")) && second == Some("compose") && has("up") {
        let p = first.unwrap();
        return Some((format!("{p} compose"), format!("{p} compose down")));
    }
    // docker-compose / podman-compose up [...]
    if matches!(first, Some("docker-compose") | Some("podman-compose")) && has("up") {
        let p = first.unwrap();
        return Some((p.to_string(), format!("{p} down")));
    }
    None
}

/// Detect tear-down-able stacks among `root` and its descendants. Deduped by the
/// teardown command (the compose CLI plus its container show up as separate
/// processes; one `down` covers them).
pub fn detect_stacks(procs: &[Proc], root: u32) -> Vec<DetectedStack> {
    let desc = descendant_pids(procs, root);
    let mut out: Vec<DetectedStack> = Vec::new();
    for p in procs {
        if !desc.contains(&p.pid) {
            continue;
        }
        if let Some((label, down)) = down_for(&p.args) {
            if out.iter().any(|d| d.down == down) {
                continue;
            }
            out.push(DetectedStack {
                label,
                down,
                command: p.args.clone(),
                pid: p.pid,
            });
        }
    }
    out
}

/// Read the live process table and detect stacks running under `root_pid`.
#[cfg(unix)]
pub fn running_under(root_pid: u32) -> Vec<DetectedStack> {
    let Ok(out) = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,args="])
        .output()
    else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    detect_stacks(&parse_ps(&text), root_pid)
}

/// No portable process-tree walk on non-Unix yet — pause still stops the pty.
#[cfg(not(unix))]
pub fn running_under(_root_pid: u32) -> Vec<DetectedStack> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    // pid ppid args — a shell under which `docker compose up` was typed, plus the
    // compose CLI's own child, an unrelated process, and a sibling tree.
    const PS: &str = "\
  100     1 -zsh
  200   100 docker compose up -d
  201   200 com.docker.cli compose up
  300   100 npm run dev
  400     1 docker compose up
  500   400 some-other-thing
";

    #[test]
    fn parses_pid_ppid_and_args() {
        let procs = parse_ps(PS);
        assert_eq!(procs.len(), 6);
        let shell = &procs[0];
        assert_eq!(shell.pid, 100);
        assert_eq!(shell.ppid, 1);
        assert_eq!(shell.args, "-zsh");
        assert_eq!(procs[1].args, "docker compose up -d");
    }

    #[test]
    fn walks_only_the_target_subtree() {
        let procs = parse_ps(PS);
        let under_100 = descendant_pids(&procs, 100);
        assert!(under_100.contains(&200));
        assert!(under_100.contains(&201)); // grandchild
        assert!(under_100.contains(&300));
        // The pid-400 tree hangs off init, not our shell.
        assert!(!under_100.contains(&400));
        assert!(!under_100.contains(&500));
    }

    #[test]
    fn detects_compose_under_shell_deduped() {
        let procs = parse_ps(PS);
        let stacks = detect_stacks(&procs, 100);
        // `docker compose up -d` AND its `com.docker.cli compose up` child both
        // map to the same `docker compose down` — reported once.
        assert_eq!(stacks.len(), 1);
        assert_eq!(stacks[0].down, "docker compose down");
        assert_eq!(stacks[0].label, "docker compose");
        // npm run dev is a descendant but has no teardown command.
        assert!(!stacks.iter().any(|s| s.down.contains("npm")));
    }

    #[test]
    fn ignores_stack_outside_the_subtree() {
        let procs = parse_ps(PS);
        // pid 400's compose is NOT under shell 100, so detecting from 100 skips it.
        assert!(detect_stacks(&procs, 100).iter().all(|s| s.pid != 400));
        // ...but detecting from 400 finds it.
        assert_eq!(detect_stacks(&procs, 400).len(), 1);
    }

    #[test]
    fn down_for_maps_up_launchers() {
        assert_eq!(
            down_for("docker compose up -d --build"),
            Some(("docker compose".into(), "docker compose down".into()))
        );
        assert_eq!(
            down_for("/usr/local/bin/docker compose up"),
            Some(("docker compose".into(), "docker compose down".into()))
        );
        assert_eq!(
            down_for("podman compose up"),
            Some(("podman compose".into(), "podman compose down".into()))
        );
        assert_eq!(
            down_for("docker-compose up"),
            Some(("docker-compose".into(), "docker-compose down".into()))
        );
        assert_eq!(down_for("tilt up --stream"), Some(("tilt".into(), "tilt down".into())));
    }

    #[test]
    fn down_for_ignores_non_up_and_plain_servers() {
        assert_eq!(down_for("docker compose ps"), None);
        assert_eq!(down_for("docker compose down"), None);
        assert_eq!(down_for("npm run dev"), None);
        assert_eq!(down_for("cargo run"), None);
        assert_eq!(down_for("vite"), None);
        assert_eq!(down_for(""), None);
    }
}
