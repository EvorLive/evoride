//! Intent docs: a living `.evoride/intent.md` capturing what the user wants to
//! build, committed alongside the code. Maintained two ways (per project config):
//!   * agent-authored — a managed directive in CLAUDE.md/AGENTS.md asks the agent
//!     to keep the doc current;
//!   * derived — EvorIde distills the user's prompts from the Claude session as a
//!     backstop (on session-end / before commit).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::claude;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntentConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_mode")]
    pub mode: String, // "both" | "agent" | "derived"
    #[serde(default = "default_path")]
    pub path: String,
}

impl Default for IntentConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: default_mode(),
            path: default_path(),
        }
    }
}

fn default_mode() -> String {
    "both".into()
}
fn default_path() -> String {
    ".intentflow/timeline.md".into()
}

/// Person credited for an intent entry: git user.name, else $USER.
fn person(project: &str) -> String {
    if let Ok(out) = std::process::Command::new("git")
        .arg("-C")
        .arg(project)
        .args(["config", "user.name"])
        .output()
    {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !name.is_empty() {
            return name;
        }
    }
    std::env::var("USER").unwrap_or_else(|_| "someone".into())
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Config {
    #[serde(default)]
    intent: IntentConfig,
}

fn config_file(project: &str) -> PathBuf {
    Path::new(project).join(".evoride").join("config.json")
}

pub fn read_config(project: &str) -> IntentConfig {
    std::fs::read_to_string(config_file(project))
        .ok()
        .and_then(|s| serde_json::from_str::<Config>(&s).ok())
        .map(|c| c.intent)
        .unwrap_or_default()
}

fn write_config(project: &str, intent: &IntentConfig) -> Result<(), String> {
    let dir = Path::new(project).join(".evoride");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cfg = Config {
        intent: intent.clone(),
    };
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(config_file(project), json).map_err(|e| e.to_string())
}

const START: &str = "<!-- evoride:intent:start -->";
const END: &str = "<!-- evoride:intent:end -->";

/// Enable/disable intent docs; wires/unwires the agent directive accordingly.
pub fn set_enabled(project: &str, enabled: bool, mode: &str) -> Result<IntentConfig, String> {
    let cfg = IntentConfig {
        enabled,
        mode: mode.to_string(),
        path: default_path(),
    };
    write_config(project, &cfg)?;

    if enabled {
        ensure_doc(project, &cfg.path)?;
        if cfg.mode == "both" || cfg.mode == "agent" {
            write_directive(project, "CLAUDE.md", &cfg.path)?;
            write_directive(project, "AGENTS.md", &cfg.path)?;
        }
        if cfg.mode == "both" || cfg.mode == "derived" {
            let _ = update(project); // seed it now
        }
    } else {
        remove_directive(project, "CLAUDE.md");
        remove_directive(project, "AGENTS.md");
    }
    Ok(cfg)
}

fn directive_block(_doc_path: &str) -> String {
    format!(
        "{START}\n## IntentFlow (EvorIde-managed)\n\
         This project uses IntentFlow — keep `.intentflow/` current. When the user states a \
         new goal update `.intentflow/vision.md`; when you make a notable change add a dated \
         entry to `.intentflow/timeline.md` crediting yourself as the agent. It is committed \
         with the code so the project's intent stays known. (If the `intentflow` CLI is \
         installed, prefer `intentflow set-intent`/timeline commands.)\n{END}"
    )
}

fn write_directive(project: &str, file: &str, doc_path: &str) -> Result<(), String> {
    let p = Path::new(project).join(file);
    let existing = std::fs::read_to_string(&p).unwrap_or_default();
    let stripped = strip_block(&existing);
    let mut out = stripped.trim_end().to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&directive_block(doc_path));
    out.push('\n');
    std::fs::write(&p, out).map_err(|e| e.to_string())
}

fn remove_directive(project: &str, file: &str) {
    let p = Path::new(project).join(file);
    if let Ok(existing) = std::fs::read_to_string(&p) {
        let stripped = strip_block(&existing);
        let _ = std::fs::write(&p, stripped.trim_end().to_string() + "\n");
    }
}

/// Remove the managed block (between markers) from `text`.
fn strip_block(text: &str) -> String {
    if let (Some(s), Some(e)) = (text.find(START), text.find(END)) {
        if e > s {
            let mut out = String::new();
            out.push_str(&text[..s]);
            out.push_str(&text[e + END.len()..]);
            return out;
        }
    }
    text.to_string()
}

const TIMELINE_TEMPLATE: &str = "# Timeline\n\
<!-- IntentFlow timeline — maintained by EvorIde and the agent. Committed with the code. -->\n";

/// Scaffold a `.intentflow/` directory (IntentFlow layout) if absent.
fn ensure_doc(project: &str, _doc_path: &str) -> Result<(), String> {
    let dir = Path::new(project).join(".intentflow");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let files: &[(&str, &str)] = &[
        ("timeline.md", TIMELINE_TEMPLATE),
        ("vision.md", "# Vision\n\n_TBD — what this project is for and why._\n"),
        ("architecture.md", "# Architecture\n\n_Key technical decisions._\n"),
        ("current-state.md", "# Current state\n\n_Snapshot of where the project is._\n"),
        ("known-issues.md", "# Known issues\n\n_Bugs and technical debt._\n"),
    ];
    for (name, body) in files {
        let p = dir.join(name);
        if !p.exists() {
            std::fs::write(&p, body).map_err(|e| e.to_string())?;
        }
    }
    let cfg = dir.join("config.json");
    if !cfg.exists() {
        let _ = std::fs::write(&cfg, "{\n  \"version\": 1,\n  \"managedBy\": \"EvorIde\"\n}\n");
    }
    Ok(())
}

pub fn read_doc(project: &str) -> String {
    std::fs::read_to_string(Path::new(project).join(".intentflow").join("timeline.md"))
        .unwrap_or_default()
}

/// Derive an update from the newest Claude session and append/refresh a TIMELINE
/// entry crediting the person and the coding agent used.
pub fn update(project: &str) -> Result<String, String> {
    ensure_doc(project, "")?;
    let doc_path = Path::new(project).join(".intentflow").join("timeline.md");
    let mut doc =
        std::fs::read_to_string(&doc_path).unwrap_or_else(|_| TIMELINE_TEMPLATE.to_string());

    let Some(si) = claude::session_intent(project) else {
        return Ok(doc);
    };
    if si.prompts.is_empty() && si.title.is_none() {
        return Ok(doc);
    }

    // Seed the goal in vision.md if still a placeholder. It lives in the
    // committed `.intentflow/` so any IDE/instance opening this project sees it.
    let vision = Path::new(project).join(".intentflow").join("vision.md");
    if let Ok(v) = std::fs::read_to_string(&vision) {
        if v.contains("_TBD") {
            let goal = si
                .title
                .clone()
                .or_else(|| si.prompts.first().cloned())
                .unwrap_or_default();
            if !goal.is_empty() {
                let _ = std::fs::write(&vision, format!("# Vision\n\n{goal}\n"));
            }
        }
    }

    let id8 = si.id.chars().take(8).collect::<String>();
    let title = si.title.clone().unwrap_or_else(|| "session".into());
    let who = person(project);
    let model = claude::usage(project).and_then(|u| u.model);
    let agent = match model {
        Some(m) => format!("Claude Code ({m})"),
        None => "Claude Code".to_string(),
    };

    // Attributed entry: who generated the intent + which coding agent.
    let mut entry = format!(
        "## {} · {title} <!-- sid:{id8} -->\n*by **{who}** · via **{agent}***\n\n",
        today()
    );
    for p in &si.prompts {
        entry.push_str(&format!("- {p}\n"));
    }

    doc = upsert_entry(&doc, &id8, &entry);
    std::fs::write(&doc_path, &doc).map_err(|e| e.to_string())?;
    Ok(doc)
}

/// Replace an existing `sid:<id8>` entry or append a new one (entries = `## `).
fn upsert_entry(doc: &str, id8: &str, entry: &str) -> String {
    let sid = format!("sid:{id8}");
    let mut kept = String::new();
    let mut skipping = false;
    for line in doc.lines() {
        if line.starts_with("## ") {
            skipping = line.contains(&sid);
        }
        if !skipping {
            kept.push_str(line);
            kept.push('\n');
        }
    }
    // Append the (new/refreshed) entry at the end — chronological, newest last.
    format!("{}\n\n{}\n", kept.trim_end(), entry.trim_end())
}

/// Current date as YYYY-MM-DD (civil-from-days, no chrono dependency).
fn today() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant's days→civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
