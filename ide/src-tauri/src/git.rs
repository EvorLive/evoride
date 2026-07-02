//! Lightweight git status for an agent's working directory — branch, dirty
//! count, and ahead/behind — shelling out to `git` so there's no heavy dep.

use serde::Serialize;
use std::process::Command;
use std::sync::Mutex;

/// Serializes every git subprocess this backend spawns, so the IDE's own pollers
/// (4 s status, 5 s changes, on-click diff) never race *each other* for a repo
/// lock. External CLI git is handled separately: all read-only calls below run
/// with `GIT_OPTIONAL_LOCKS=0` so they don't take `index.lock` to rewrite the
/// refreshed index/untracked-cache — that's what used to collide with a
/// concurrent CLI `git add`/`commit` and fail it with EEXIST. (This is exactly
/// what VS Code's git extension does.)
static GIT_LOCK: Mutex<()> = Mutex::new(());

/// Run a git subprocess under [`GIT_LOCK`]. When `read_only`, disable git's
/// optional index locking so we never fight an external writer for `index.lock`.
fn run(cwd: &str, args: &[&str], read_only: bool) -> std::io::Result<std::process::Output> {
    let _guard = GIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    if read_only {
        cmd.env("GIT_OPTIONAL_LOCKS", "0");
    }
    cmd.output()
}

#[derive(Debug, Clone, Serialize)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: String,
    /// Number of changed/untracked entries (`git status --porcelain` lines).
    pub dirty: u32,
    pub ahead: u32,
    pub behind: u32,
    /// Detached HEAD: `branch` holds the short commit SHA, not a ref name.
    pub detached: bool,
}

impl GitStatus {
    fn not_repo() -> Self {
        Self {
            is_repo: false,
            branch: String::new(),
            dirty: 0,
            ahead: 0,
            behind: 0,
            detached: false,
        }
    }
}

/// Read-only git query (status/branch/rev-list/…). Runs with optional locks
/// disabled so it can't grab `index.lock` out from under a CLI writer.
fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let out = run(cwd, args, true).ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Read a compact git status for `cwd`. Never errors — returns a non-repo
/// status if the directory isn't under git.
pub fn status(cwd: &str) -> GitStatus {
    let mut branch = match git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Some(b) => b,
        None => return GitStatus::not_repo(),
    };

    // Detached HEAD: `--abbrev-ref` yields the literal "HEAD". Show the short
    // SHA instead so the status bar doesn't present "HEAD" as a branch name.
    let detached = branch == "HEAD";
    if detached {
        branch = git(cwd, &["rev-parse", "--short", "HEAD"]).unwrap_or(branch);
    }

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
        detached,
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
    let mut s = run_diff(cwd, &args);

    // Untracked/new file: `diff HEAD` shows nothing, so show the whole file as
    // additions via --no-index against /dev/null.
    if s.trim().is_empty() {
        if let Some(f) = file {
            s = run_diff(cwd, &["--no-pager", "diff", "--no-index", "--", "/dev/null", f]);
        }
    }

    if s.len() > MAX_DIFF {
        // Truncate on a UTF-8 char boundary — a blind `truncate(MAX_DIFF)` panics
        // (and takes down the git_diff handler) if MAX_DIFF lands mid-codepoint,
        // which an untrusted diff can arrange.
        let mut cut = MAX_DIFF;
        while cut > 0 && !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n… (diff truncated)");
    }
    s
}

fn run_diff(cwd: &str, args: &[&str]) -> String {
    // Diff is read-only — disable optional locks so it never blocks/breaks a
    // concurrent CLI git op refreshing the index.
    run(cwd, args, true)
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
pub struct Branches {
    pub current: String,
    pub all: Vec<String>,
}

/// Local branches with the current one flagged.
pub fn branches(cwd: &str) -> Branches {
    let current = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .filter(|b| b != "HEAD") // detached: no current branch
        .unwrap_or_default();
    let all = git(cwd, &["branch", "--format=%(refname:short)"])
        .map(|s| {
            s.lines()
                .map(|l| l.trim().to_string())
                // Drop the "(HEAD detached at …)" placeholder git emits when detached.
                .filter(|l| !l.is_empty() && !l.starts_with('('))
                .collect()
        })
        .unwrap_or_default();
    Branches { current, all }
}

/// Reject branch/ref names that git would parse as an option (leading `-`), so a
/// crafted name like `--upload-pack=…` or any `-`-prefixed flag can't be smuggled
/// in as a git argument. (For `checkout` a literal `--` separator can't be used —
/// it would make git treat the name as a *pathspec* instead of a ref — so
/// rejecting option-looking names is the correct guard.)
fn safe_ref(name: &str) -> Result<&str, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("branch name is empty".into());
    }
    if n.starts_with('-') {
        return Err("invalid branch name".into());
    }
    Ok(n)
}

/// Checkout an existing branch.
pub fn checkout(cwd: &str, branch: &str) -> Result<String, String> {
    let branch = safe_ref(branch)?;
    run_git(cwd, &["checkout", branch])
}

/// Create and switch to a new branch.
pub fn create_branch(cwd: &str, name: &str) -> Result<String, String> {
    let name = safe_ref(name)?;
    run_git(cwd, &["checkout", "-b", name])
}

/// Stage everything and commit with `message` — no push, so a network/auth
/// failure can't strand the user mid-operation.
pub fn commit(cwd: &str, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("commit message is empty".into());
    }
    run_git(cwd, &["add", "-A"])?;
    run_git(cwd, &["commit", "-m", message])
}

/// Stage everything, commit with `message`, and push. If the push fails the
/// error says so explicitly — the commit already exists locally and must not
/// look like it was lost.
pub fn commit_and_push(cwd: &str, message: &str) -> Result<String, String> {
    let committed = commit(cwd, message)?;
    match push(cwd) {
        Ok(pushed) => Ok(format!("{committed}\n{pushed}").trim().to_string()),
        Err(e) => Err(format!(
            "Committed locally, but the push failed — your commit is safe; push again when resolved.\n{e}"
        )),
    }
}

/// Fetch remote refs so ahead/behind reflects the latest remote state.
pub fn fetch(cwd: &str) -> Result<(), String> {
    run_git(cwd, &["fetch", "--quiet"]).map(|_| ())
}

/// Pull (merge, no editor) from the remote.
pub fn pull(cwd: &str) -> Result<String, String> {
    run_git(cwd, &["pull", "--no-edit"])
}

/// Push the current branch. A branch with no upstream yet (fresh `checkout -b`)
/// is pushed with `-u origin <branch>` so the first push just works and
/// ahead/behind starts tracking. The branch name comes from git itself (git
/// refuses to create refs starting with `-`), so it can't be an option.
pub fn push(cwd: &str) -> Result<String, String> {
    let has_upstream = git(cwd, &["rev-parse", "--abbrev-ref", "@{u}"]).is_some();
    if has_upstream {
        return run_git(cwd, &["push"]);
    }
    match git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Some(branch) if branch != "HEAD" => {
            run_git(cwd, &["push", "-u", "origin", branch.as_str()])
        }
        _ => run_git(cwd, &["push"]), // detached/unknown — let git explain
    }
}

/// Run a mutating git subcommand (checkout/commit/push/…), returning stdout or
/// an error containing stderr. Keeps normal locking — these genuinely write —
/// but still serializes through [`GIT_LOCK`] so two backend writers can't race.
fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = run(cwd, args, false).map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
