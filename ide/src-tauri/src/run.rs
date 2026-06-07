//! Run detection + a per-project run config (`.evoride/run.json`) describing one
//! or more services (monorepo-aware), used by the Run/Stop controls.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// One runnable service within a project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Service {
    pub name: String,
    pub command: String,
    /// Working dir relative to the project root ("" = root).
    #[serde(default)]
    pub cwd: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RunConfig {
    #[serde(default)]
    services: Vec<Service>,
}

fn config_path(path: &str) -> std::path::PathBuf {
    Path::new(path).join(".evoride").join("run.json")
}

/// Read the project's run config, or fall back to a single detected service.
pub fn read_config(path: &str) -> Vec<Service> {
    if let Ok(text) = std::fs::read_to_string(config_path(path)) {
        if let Ok(rc) = serde_json::from_str::<RunConfig>(&text) {
            if !rc.services.is_empty() {
                return rc.services;
            }
        }
    }
    fallback_services(path)
}

/// Write a starter run config — monorepo-aware — and return the services.
pub fn create_config(path: &str) -> Result<Vec<Service>, String> {
    let services = scaffold_services(path);
    let dir = Path::new(path).join(".evoride");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let rc = RunConfig {
        services: services.clone(),
    };
    let json = serde_json::to_string_pretty(&rc).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("run.json"), json).map_err(|e| e.to_string())?;
    Ok(services)
}

fn fallback_services(path: &str) -> Vec<Service> {
    match detect_run_command(path) {
        Some(cmd) => vec![Service {
            name: "run".into(),
            command: cmd,
            cwd: String::new(),
        }],
        None => Vec::new(),
    }
}

/// Build services from workspace packages (monorepo) or a single detected cmd.
fn scaffold_services(path: &str) -> Vec<Service> {
    let root = Path::new(path);
    let mgr = pkg_manager(root);
    let mut out = Vec::new();

    for glob in workspace_globs(root) {
        let prefix = glob.strip_suffix("/*").unwrap_or(&glob);
        let dir = root.join(prefix);
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.filter_map(|e| e.ok()) {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let pkg = e.path().join("package.json");
            if let Some(script) = pick_script(&pkg) {
                let name = e.file_name().to_string_lossy().to_string();
                out.push(Service {
                    name,
                    command: run_cmd(mgr, &script),
                    cwd: format!("{prefix}/{}", e.file_name().to_string_lossy()),
                });
            }
        }
    }

    if out.is_empty() {
        let mut fb = fallback_services(path);
        if fb.is_empty() {
            fb.push(Service {
                name: "run".into(),
                command: String::new(),
                cwd: String::new(),
            });
        }
        return fb;
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Workspace package globs from pnpm-workspace.yaml or package.json workspaces.
fn workspace_globs(root: &Path) -> Vec<String> {
    if let Ok(text) = std::fs::read_to_string(root.join("pnpm-workspace.yaml")) {
        let globs: Vec<String> = text
            .lines()
            .map(|l| l.trim())
            .filter(|l| l.starts_with('-'))
            .map(|l| {
                l.trim_start_matches('-')
                    .trim()
                    .trim_matches(|c| c == '\'' || c == '"')
                    .to_string()
            })
            .filter(|s| !s.is_empty())
            .collect();
        if !globs.is_empty() {
            return globs;
        }
    }
    if let Ok(text) = std::fs::read_to_string(root.join("package.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            let ws = v.get("workspaces");
            let arr = ws
                .and_then(|w| w.as_array().cloned())
                .or_else(|| ws.and_then(|w| w.get("packages")).and_then(|p| p.as_array().cloned()));
            if let Some(arr) = arr {
                return arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect();
            }
        }
    }
    Vec::new()
}

fn pkg_manager(root: &Path) -> &'static str {
    if root.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if root.join("yarn.lock").exists() {
        "yarn"
    } else if root.join("bun.lockb").exists() {
        "bun"
    } else {
        "npm"
    }
}

fn run_cmd(mgr: &str, script: &str) -> String {
    if mgr == "yarn" || mgr == "bun" {
        format!("{mgr} {script}")
    } else {
        format!("{mgr} run {script}")
    }
}

pub fn detect_run_command(path: &str) -> Option<String> {
    let p = Path::new(path);

    if p.join("Cargo.toml").exists() {
        return Some("cargo run".into());
    }

    if p.join("package.json").exists() {
        let mgr = if p.join("pnpm-lock.yaml").exists() {
            "pnpm"
        } else if p.join("yarn.lock").exists() {
            "yarn"
        } else if p.join("bun.lockb").exists() {
            "bun"
        } else {
            "npm"
        };
        let script = pick_script(&p.join("package.json")).unwrap_or_else(|| "dev".into());
        // yarn/bun run scripts without the `run` keyword.
        return Some(if mgr == "yarn" || mgr == "bun" {
            format!("{mgr} {script}")
        } else {
            format!("{mgr} run {script}")
        });
    }

    if p.join("go.mod").exists() {
        return Some("go run .".into());
    }
    if p.join("manage.py").exists() {
        return Some("python manage.py runserver".into());
    }
    if p.join("Makefile").exists() {
        return Some("make".into());
    }
    None
}

/// Pick the most likely dev script from package.json.
fn pick_script(pkg: &Path) -> Option<String> {
    let text = std::fs::read_to_string(pkg).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let scripts = v.get("scripts")?.as_object()?;
    for name in ["dev", "start", "serve", "develop"] {
        if scripts.contains_key(name) {
            return Some(name.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("eterm-run-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn detects_cargo() {
        let d = tmpdir("cargo");
        std::fs::write(d.join("Cargo.toml"), "[package]").unwrap();
        assert_eq!(
            detect_run_command(d.to_str().unwrap()),
            Some("cargo run".into())
        );
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn detects_pnpm_dev_script() {
        let d = tmpdir("pnpm");
        std::fs::write(
            d.join("package.json"),
            r#"{"scripts":{"build":"x","dev":"vite"}}"#,
        )
        .unwrap();
        std::fs::write(d.join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(
            detect_run_command(d.to_str().unwrap()),
            Some("pnpm run dev".into())
        );
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn none_when_unknown() {
        let d = tmpdir("empty");
        assert_eq!(detect_run_command(d.to_str().unwrap()), None);
        let _ = std::fs::remove_dir_all(d);
    }
}
