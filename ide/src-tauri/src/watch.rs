//! Native filesystem watcher driving the explorer's auto-refresh.
//!
//! The file explorer used to require a manual reload to pick up files an agent
//! (or any external tool) created/renamed/deleted on disk. This module watches
//! each opened project root recursively and emits a debounced `fs-changed`
//! event so the webview can re-read the affected tree.
//!
//! Like the other fs surfaces it is scoped to project roots only — we only ever
//! `watch()` a path that came from [`crate::store::Store::list_projects`] (and
//! canonicalize it first), so the watcher can't be pointed outside an opened
//! project. Heavy/noisy directories (build output, `.git`, the `.evoride`
//! agent-log dir) are filtered out so a `cargo build` or an agent appending to
//! its task log doesn't spam refreshes.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;

use crate::event::{self, Sink};
use crate::store::Store;

/// Holds one live debouncer per (canonical) project root. Keeping the
/// `Debouncer` alive is what keeps the watch active; dropping it stops it.
#[derive(Default)]
pub struct WatchManager {
    watchers: Mutex<HashMap<PathBuf, Debouncer<RecommendedWatcher>>>,
}

#[derive(Clone, Serialize)]
struct FsChanged {
    /// The project root (as the webview knows it) whose tree changed.
    root: String,
}

/// Directories whose churn must never trigger an explorer refresh.
fn should_ignore(path: &Path) -> bool {
    path.components().any(|c| {
        if let Component::Normal(n) = c {
            matches!(
                n.to_string_lossy().as_ref(),
                ".git" | "node_modules" | "target" | "dist" | ".next" | ".evoride"
            )
        } else {
            false
        }
    })
}

/// Reconcile the active watchers with the currently-open projects: start a
/// watcher for any newly-opened root, drop watchers for closed ones. Safe to
/// call repeatedly (on startup and whenever a project is added/removed).
pub fn sync(store: &Store, mgr: &WatchManager, sink: Sink) {
    // Canonical root -> the original path string the webview uses for it.
    let mut desired: HashMap<PathBuf, String> = HashMap::new();
    for p in store.list_projects() {
        if let Ok(canon) = std::fs::canonicalize(&p.path) {
            desired.entry(canon).or_insert(p.path);
        }
    }

    let mut watchers = mgr.watchers.lock().unwrap();
    watchers.retain(|root, _| desired.contains_key(root));
    for (canon, original) in desired {
        if watchers.contains_key(&canon) {
            continue;
        }
        match make_watcher(sink.clone(), &canon, original) {
            Ok(d) => {
                watchers.insert(canon, d);
            }
            Err(e) => eprintln!("fs watch failed for {}: {e}", canon.display()),
        }
    }
}

fn make_watcher(
    sink: Sink,
    canon: &Path,
    original: String,
) -> Result<Debouncer<RecommendedWatcher>, notify_debouncer_mini::notify::Error> {
    let mut debouncer = new_debouncer(Duration::from_millis(300), move |res: DebounceEventResult| {
        if let Ok(events) = res {
            // Only refresh when something outside the ignored dirs changed.
            if events.iter().any(|e| !should_ignore(&e.path)) {
                event::emit(
                    sink.as_ref(),
                    "fs-changed",
                    FsChanged {
                        root: original.clone(),
                    },
                );
            }
        }
    })?;
    debouncer
        .watcher()
        .watch(canon, RecursiveMode::Recursive)?;
    Ok(debouncer)
}
