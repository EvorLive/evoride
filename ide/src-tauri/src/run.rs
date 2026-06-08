//! Run detection + a per-project run config (`.evoride/run.json`) describing one
//! or more services (monorepo-aware), used by the Run/Stop controls.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One runnable service within a project.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Service {
    pub name: String,
    pub command: String,
    /// Working dir relative to the project root ("" = root).
    #[serde(default)]
    pub cwd: String,
    /// Optional port it serves on (from AI-generated runinfo).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// Optional URL to open when it's up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Optional regex matching a "ready" line in the service's output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ready_when: Option<String>,
}

/// Absolute path to the per-machine, AI-generated run config for a project:
/// `~/.evoride/{project_id}/runinfo.json` — kept OUT of the repo.
fn runinfo_path(project_id: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(Path::new(&home).join(".evoride").join(project_id).join("runinfo.json"))
}

/// Read the AI-generated runinfo for a project, if present + non-empty.
pub fn read_runinfo(project_id: &str) -> Option<Vec<Service>> {
    let text = std::fs::read_to_string(runinfo_path(project_id)?).ok()?;
    let rc: RunConfig = serde_json::from_str(&text).ok()?;
    (!rc.services.is_empty()).then_some(rc.services)
}

/// Services for a project, by precedence: AI runinfo (`~/.evoride/{id}/...`) →
/// committed repo `.evoride/run.json` → built-in auto-detect.
pub fn services_for(project_id: &str, path: &str) -> Vec<Service> {
    read_runinfo(project_id).unwrap_or_else(|| read_config(path))
}

/// The instruction EvorIDE hands an agent so it investigates how to run the
/// project and writes `~/.evoride/{project_id}/runinfo.json`. One line, so it can
/// be sent to an interactive agent as a single prompt.
pub fn setup_instruction(project_id: &str) -> String {
    let runinfo = runinfo_path(project_id)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    format!(
        "EvorIDE: figure out how to RUN this project for local development. Inspect \
package.json scripts (+ workspaces / pnpm-workspace.yaml), Cargo.toml, Dockerfile / \
docker-compose.yml, Makefile, Procfile, etc. Prefer Docker if a compose file defines the \
dev stack; verify required tools exist (e.g. run `which docker`). IMPORTANT: if this is a \
MONOREPO with several runnable apps/services, include ONE entry per app in `services` \
(e.g. 4 apps -> 4 entries), each with its own name, command, cwd, and port/url. Then WRITE \
the run config as JSON to `{runinfo}` (create the directory) with this exact shape: {{\
\"generated_by\":\"<your model>\",\"services\":[{{\"name\":\"web\",\"command\":\"<exact \
shell command to start it>\",\"cwd\":\"<dir relative to project root, empty string for \
root>\",\"port\":3000,\"url\":\"http://localhost:3000\",\"ready_when\":\"<optional regex \
matching a ready line in the output>\"}}],\"notes\":\"<anything I should know, e.g. needs \
Docker running>\"}}. Use real, runnable commands. If `.intentflow/timeline.md` exists, \
append a one-line dated entry noting you configured the run (credit the model). Finally, \
summarize what you set up — then I may give you more to do, so stay ready."
    )
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
            ..Default::default()
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
                    ..Default::default()
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
                ..Default::default()
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

    if let Ok(cargo) = std::fs::read_to_string(p.join("Cargo.toml")) {
        // Bare `cargo run` only works for a runnable crate. A pure workspace
        // ([workspace] with no [package]) is ambiguous — leave it unconfigured so
        // "✨ Set up run" picks the right `cargo run -p <crate>` per app.
        if cargo.contains("[workspace]") && !cargo.contains("[package]") {
            return None;
        }
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

    #[test]
    fn pure_cargo_workspace_is_not_runnable() {
        // [workspace] with no [package] → bare `cargo run` is ambiguous → None,
        // so "Set up run" takes over instead of a failing run.
        let d = tmpdir("cargo-ws");
        std::fs::write(d.join("Cargo.toml"), "[workspace]\nmembers = [\"a\", \"b\"]").unwrap();
        assert_eq!(detect_run_command(d.to_str().unwrap()), None);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn ai_runinfo_takes_precedence_over_detect() {
        let home = tmpdir("home");
        // SAFETY: test-only; no other run test depends on HOME.
        unsafe { std::env::set_var("HOME", &home) };
        let pid = "proj-abc-123";
        let dir = home.join(".evoride").join(pid);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("runinfo.json"),
            r#"{"generated_by":"claude","services":[
                {"name":"web","command":"docker compose up","cwd":"","port":3000,"url":"http://localhost:3000"}
            ],"notes":"needs docker"}"#,
        )
        .unwrap();

        // A project dir that WOULD detect cargo — runinfo must still win.
        let proj = tmpdir("proj");
        std::fs::write(proj.join("Cargo.toml"), "[package]").unwrap();

        let svcs = services_for(pid, proj.to_str().unwrap());
        assert_eq!(svcs.len(), 1);
        assert_eq!(svcs[0].command, "docker compose up");
        assert_eq!(svcs[0].port, Some(3000));
        assert_eq!(svcs[0].url.as_deref(), Some("http://localhost:3000"));

        // The instruction points the agent at the right file + mentions docker.
        let instr = setup_instruction(pid);
        assert!(instr.contains("runinfo.json"));
        assert!(instr.contains(pid));
        assert!(instr.to_lowercase().contains("docker"));

        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&proj);
    }
}
