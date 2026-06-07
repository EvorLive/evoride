//! Minimal read-only filesystem access for the project file viewer.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileContent {
    pub content: String,
    pub truncated: bool,
    pub binary: bool,
}

const MAX_ENTRIES: usize = 2000;
const MAX_FILE: usize = 250_000;

/// List a directory: directories first, then files, case-insensitive.
pub fn read_dir(path: &str) -> Result<Vec<FileEntry>, String> {
    let mut entries: Vec<FileEntry> = std::fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let is_dir = e.file_type().ok()?.is_dir();
            Some(FileEntry {
                name,
                path: e.path().to_string_lossy().to_string(),
                is_dir,
            })
        })
        .take(MAX_ENTRIES)
        .collect();

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// Read a file as UTF-8 text, capped; flags binary/truncated rather than erroring.
pub fn read_file(path: &str) -> Result<FileContent, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("is a directory".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let truncated = bytes.len() > MAX_FILE;
    let slice = &bytes[..bytes.len().min(MAX_FILE)];
    match std::str::from_utf8(slice) {
        Ok(s) => Ok(FileContent {
            content: s.to_string(),
            truncated,
            binary: false,
        }),
        Err(_) => Ok(FileContent {
            content: String::new(),
            truncated,
            binary: true,
        }),
    }
}

/// Overwrite a file's contents (used by the editor's Save).
pub fn write_file(path: &str, content: &str) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| e.to_string())
}

/// Create a new empty file (errors if it already exists); makes parent dirs.
pub fn create_file(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if p.exists() {
        return Err("a file or folder already exists there".into());
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, "").map_err(|e| e.to_string())
}

/// Best-effort home directory.
pub fn home() -> Option<String> {
    std::env::var("HOME").ok().filter(|h| Path::new(h).exists())
}

const MAX_FILES: usize = 6000;

/// Directory names we never descend into (heavy/build/vcs dirs).
fn is_skipped_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | ".next" | ".DS_Store"
    )
}

/// Recursively list files under `root`, returning repo-relative paths (no dirs),
/// capped at `MAX_FILES` and skipping heavy/ignored directories. A simple manual
/// walk — no extra crates.
pub fn list_files(root: &str) -> Vec<String> {
    let root_path = Path::new(root);
    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root_path.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if out.len() >= MAX_FILES {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.filter_map(|e| e.ok()) {
            if out.len() >= MAX_FILES {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = match entry.file_type() {
                Ok(t) => t.is_dir(),
                Err(_) => continue,
            };
            if is_dir {
                if is_skipped_dir(&name) {
                    continue;
                }
                // Skip the nested agents log dir specifically.
                if name == "agents" && dir.file_name().map(|n| n == ".evoride").unwrap_or(false) {
                    continue;
                }
                stack.push(entry.path());
            } else {
                if name == ".DS_Store" {
                    continue;
                }
                if let Ok(rel) = entry.path().strip_prefix(root_path) {
                    out.push(rel.to_string_lossy().to_string());
                }
            }
        }
    }

    out.sort();
    out
}
