//! Path confinement for the webview-exposed filesystem commands.
//!
//! The IDE's file viewer/editor only ever operates *inside* an opened project,
//! but the raw `read_file` / `write_file` / `read_dir` / `list_files` /
//! `create_file` commands accept any path string the webview sends. Without
//! confinement a webview bug (or a future XSS — see the disabled-then-tightened
//! CSP) could read or clobber arbitrary files: `~/.ssh/id_rsa`,
//! `~/.evoride/secrets.json`, the user's shell rc, etc. Every such command first
//! runs its path through [`confine`], which resolves symlinks/`..` and rejects
//! anything that doesn't live under one of the registered project roots.

use std::path::{Path, PathBuf};

/// The registered project roots (the only directory trees the file commands may
/// touch).
pub fn project_roots(store: &crate::store::Store) -> Vec<PathBuf> {
    store
        .list_projects()
        .into_iter()
        .map(|p| PathBuf::from(p.path))
        .collect()
}

/// Resolve `path` and require it to live inside one of `roots`. Symlinks and the
/// real portion of the path are canonicalized (so a symlink pointing outside a
/// project is caught), the path must be absolute, and any `..` component is
/// refused outright — the IDE always passes absolute, traversal-free paths inside
/// a project, so this never rejects legitimate use.
pub fn confine(roots: &[PathBuf], path: &str) -> Result<PathBuf, String> {
    if roots.is_empty() {
        return Err("no open project to resolve this path against".into());
    }
    let requested = Path::new(path);
    if !requested.is_absolute() {
        return Err("path must be absolute".into());
    }
    if requested
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("path traversal is not allowed".into());
    }

    // Canonicalize the longest existing prefix (resolving symlinks on the real
    // part of the path), then re-attach any not-yet-existing leaf components
    // (e.g. the target of `create_file`).
    let mut probe = requested.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let canon = loop {
        if let Ok(c) = std::fs::canonicalize(&probe) {
            break c;
        }
        match probe.file_name() {
            Some(name) => tail.push(name.to_os_string()),
            None => return Err("could not resolve path".into()),
        }
        if !probe.pop() {
            return Err("could not resolve path".into());
        }
    };
    let mut full = canon;
    for comp in tail.iter().rev() {
        full.push(comp);
    }

    let roots_canon: Vec<PathBuf> = roots
        .iter()
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .collect();
    if roots_canon.iter().any(|r| full.starts_with(r)) {
        Ok(full)
    } else {
        Err("path is outside the open project".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("eterm-guard-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::canonicalize(&d).unwrap()
    }

    #[test]
    fn allows_inside_root() {
        let root = tmp("inside");
        std::fs::write(root.join("a.txt"), "x").unwrap();
        let p = root.join("a.txt");
        assert!(confine(&[root.clone()], p.to_str().unwrap()).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn allows_nonexistent_leaf_for_create() {
        let root = tmp("create");
        let p = root.join("sub").join("new.txt");
        // parent doesn't exist yet — still allowed because it resolves under root
        assert!(confine(&[root.clone()], p.to_str().unwrap()).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_traversal() {
        let root = tmp("trav");
        let p = format!("{}/../../etc/passwd", root.to_str().unwrap());
        assert!(confine(&[root.clone()], &p).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_outside_root() {
        let root = tmp("outside");
        assert!(confine(&[root.clone()], "/etc/hosts").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_symlink_escape() {
        let root = tmp("symlink");
        let outside = tmp("symlink-target");
        std::fs::write(outside.join("secret"), "s").unwrap();
        let link = root.join("escape");
        #[cfg(unix)]
        {
            let _ = std::os::unix::fs::symlink(&outside, &link);
            let p = link.join("secret");
            // canonicalize resolves the symlink to `outside`, which is not under root
            assert!(confine(&[root.clone()], p.to_str().unwrap()).is_err());
        }
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
