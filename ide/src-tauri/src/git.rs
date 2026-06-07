//! Lightweight git status for an agent's working directory — branch, dirty
//! count, and ahead/behind — shelling out to `git` so there's no heavy dep.

use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: String,
    /// Number of changed/untracked entries (`git status --porcelain` lines).
    pub dirty: u32,
    pub ahead: u32,
    pub behind: u32,
}

impl GitStatus {
    fn not_repo() -> Self {
        Self {
            is_repo: false,
            branch: String::new(),
            dirty: 0,
            ahead: 0,
            behind: 0,
        }
    }
}

fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Read a compact git status for `cwd`. Never errors — returns a non-repo
/// status if the directory isn't under git.
pub fn status(cwd: &str) -> GitStatus {
    let branch = match git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Some(b) => b,
        None => return GitStatus::not_repo(),
    };

    let dirty = git(cwd, &["status", "--porcelain"])
        .map(|s| s.lines().filter(|l| !l.is_empty()).count() as u32)
        .unwrap_or(0);

    // ahead/behind vs upstream; absent upstream → 0/0.
    let (ahead, behind) = git(cwd, &["rev-list", "--left-right", "--count", "@{u}...HEAD"])
        .and_then(|s| {
            let mut it = s.split_whitespace();
            let behind = it.next()?.parse().ok()?;
            let ahead = it.next()?.parse().ok()?;
            Some((ahead, behind))
        })
        .unwrap_or((0, 0));

    GitStatus {
        is_repo: true,
        branch,
        dirty,
        ahead,
        behind,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FileChange {
    pub path: String,
    /// Two-char porcelain code, e.g. " M", "??", "A ".
    pub status: String,
}

/// Changed/untracked files (`git status --porcelain`).
pub fn changes(cwd: &str) -> Vec<FileChange> {
    git(cwd, &["status", "--porcelain"])
        .map(|s| {
            s.lines()
                .filter(|l| l.len() > 3)
                .map(|l| FileChange {
                    status: l[..2].to_string(),
                    path: l[3..].to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

const MAX_DIFF: usize = 200_000;

/// Working-tree diff vs HEAD (tracked changes), capped. Optionally a single file.
pub fn diff(cwd: &str, file: Option<&str>) -> String {
    let mut args: Vec<&str> = vec!["--no-pager", "diff", "HEAD"];
    if let Some(f) = file {
        args.push("--");
        args.push(f);
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(&args)
        .output();
    match out {
        Ok(o) => {
            let mut s = String::from_utf8_lossy(&o.stdout).to_string();
            if s.len() > MAX_DIFF {
                s.truncate(MAX_DIFF);
                s.push_str("\n… (diff truncated)");
            }
            s
        }
        Err(_) => String::new(),
    }
}

/// Stage everything, commit with `message`, and push. Returns combined output
/// or the first failing step's error.
pub fn commit_and_push(cwd: &str, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("commit message is empty".into());
    }
    run_git(cwd, &["add", "-A"])?;
    let commit = run_git(cwd, &["commit", "-m", message])?;
    let push = run_git(cwd, &["push"])?;
    Ok(format!("{commit}\n{push}").trim().to_string())
}

/// Fetch remote refs so ahead/behind reflects the latest remote state.
pub fn fetch(cwd: &str) -> Result<(), String> {
    run_git(cwd, &["fetch", "--quiet"]).map(|_| ())
}

/// Pull (merge, no editor) from the remote.
pub fn pull(cwd: &str) -> Result<String, String> {
    run_git(cwd, &["pull", "--no-edit"])
}

/// Push the current branch.
pub fn push(cwd: &str) -> Result<String, String> {
    run_git(cwd, &["push"])
}

/// Run a git subcommand, returning stdout or an error containing stderr.
fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
