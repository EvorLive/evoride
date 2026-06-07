//! Minimal read-only filesystem access for the project file viewer.

use serde::Serialize;
use std::path::Path;

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

/// Best-effort home directory.
pub fn home() -> Option<String> {
    std::env::var("HOME").ok().filter(|h| Path::new(h).exists())
}
