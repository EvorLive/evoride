//! Bundled agent skills. The IDE ships a few agent "skills" (SKILL.md
//! directories) inside the binary and installs the enabled ones into the user's
//! global skills dirs, so every agent the IDE launches picks them up. Skills are
//! auto-enabled by default and can be turned off in Settings → Skills; disabling
//! removes the installed copies.
//!
//! The SKILL.md format is vendor-neutral, but each CLI reads from its own
//! user-level location. We install into all of them at once so a skill is shared
//! across CLIs and any newly-added agent inherits it automatically:
//!   - `~/.claude/skills` — Claude Code
//!   - `~/.agents/skills` — Codex + the vendor-neutral `.agents` convention
//!
//! We only ever touch directories we created (marked with a sentinel file), so a
//! user's own same-named skill is never clobbered or deleted.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// One file inside a bundled skill (path relative to the skill's own dir).
struct SkillFile {
    rel: &'static str,
    body: &'static str,
}

/// A skill shipped inside the app, installable into `~/.claude/skills/<id>`.
struct BundledSkill {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    /// Installed automatically on first run (the user can still disable it).
    default_on: bool,
    files: &'static [SkillFile],
}

/// The registry of bundled skills. Add new skills here; embedding via
/// `include_str!` keeps them in the binary so install needs no network.
const SKILLS: &[BundledSkill] = &[BundledSkill {
    id: "agent-memory",
    name: "Agent Memory",
    description: "Persistent .ai/ knowledge layer so a fresh or parallel agent starts from accumulated understanding instead of re-exploring the codebase. Saves context at the end of long sessions.",
    default_on: true,
    files: &[
        SkillFile {
            rel: "SKILL.md",
            body: include_str!("../skills/agent-memory/SKILL.md"),
        },
        SkillFile {
            rel: "references/templates.md",
            body: include_str!("../skills/agent-memory/references/templates.md"),
        },
        SkillFile {
            rel: "references/example.md",
            body: include_str!("../skills/agent-memory/references/example.md"),
        },
    ],
}];

/// Sentinel dropped in every dir we install, so we never remove a skill the user
/// authored themselves that happens to share an id.
pub const MARKER: &str = ".evoride-managed";

/// Contents of the managed-marker file (kept in one place so the install path —
/// including the Claude-driven git install — writes exactly what we look for).
pub const MARKER_BODY: &str = "Managed by EvorIDE. Toggle in Settings \u{2192} Skills.\n";

/// Skill row for the Settings → Skills tab.
#[derive(Serialize)]
pub struct SkillInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    /// Bundled with the app (toggle off to remove). External (git-installed)
    /// skills are `false` — they get a Remove action instead.
    pub builtin: bool,
}

/// User-level skills dirs, one per skill-aware CLI convention. Installing into
/// all of them means a skill is shared across Claude Code, Codex, and any future
/// agent that follows the `.agents` convention — so a newly-added agent inherits
/// every enabled skill with no extra configuration.
fn skills_roots() -> Vec<PathBuf> {
    let Some(home) = crate::fs::home() else {
        return Vec::new();
    };
    let h = Path::new(&home);
    vec![
        h.join(".claude").join("skills"), // Claude Code
        h.join(".agents").join("skills"), // Codex + vendor-neutral agents
    ]
}

/// A bundled skill is enabled unless the user disabled it (default_on skills) —
/// non-default skills require an explicit opt-in, which isn't modeled yet, so
/// they stay off.
fn is_enabled(skill: &BundledSkill, disabled: &[String]) -> bool {
    skill.default_on && !disabled.iter().any(|d| d == skill.id)
}

/// Write a skill's files into `<root>/<id>` for every skills root, plus the
/// managed marker so we can safely remove it later.
fn install(skill: &BundledSkill) -> std::io::Result<()> {
    for root in skills_roots() {
        let dir = root.join(skill.id);
        for f in skill.files {
            let path = dir.join(f.rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, f.body)?;
        }
        std::fs::write(dir.join(MARKER), MARKER_BODY)?;
    }
    Ok(())
}

/// A skill id must be a single, safe path segment — no separators, no `..`, no
/// absolute paths. `root.join(id)` with a traversing id (e.g. `../../foo`) would
/// otherwise let a crafted id point `remove_dir_all` at a directory outside the
/// skills roots; combined with a planted marker file that becomes an
/// arbitrary-directory delete. Reject anything that isn't a plain name.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains("..")
        && !id.contains('\0')
}

/// Remove an installed skill dir from every root — but only where we installed
/// it (marker present), never a user's own same-named skill.
fn uninstall(id: &str) {
    if !valid_id(id) {
        return;
    }
    for root in skills_roots() {
        let dir = root.join(id);
        if dir.join(MARKER).exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

/// Bring the installed skills in line with the saved disabled list. Called at
/// startup so a fresh install gets the default skills and toggles persist.
pub fn sync(disabled: &[String]) {
    for s in SKILLS {
        if is_enabled(s, disabled) {
            let _ = install(s);
        } else {
            uninstall(s.id);
        }
    }
}

/// The skill list for the UI: bundled skills (with enabled state) followed by
/// any git-installed (external) skills discovered on disk.
pub fn list(disabled: &[String]) -> Vec<SkillInfo> {
    let mut out: Vec<SkillInfo> = SKILLS
        .iter()
        .map(|s| SkillInfo {
            id: s.id.to_string(),
            name: s.name.to_string(),
            description: s.description.to_string(),
            enabled: is_enabled(s, disabled),
            builtin: true,
        })
        .collect();
    out.extend(installed_external());
    out
}

/// Install or remove a single skill in response to a UI toggle.
pub fn set_enabled(id: &str, enabled: bool) {
    if let Some(s) = SKILLS.iter().find(|s| s.id == id) {
        if enabled {
            let _ = install(s);
        } else {
            uninstall(id);
        }
    }
}

/// Remove a skill by id from every root we manage (used for git-installed
/// skills' "Remove"). Safe — only touches dirs carrying our marker.
pub fn remove(id: &str) {
    uninstall(id);
}

/// Discover git-installed skills: managed dirs (carrying our marker) under the
/// skills roots whose id ISN'T one of the bundled ones. Deduped by id; name +
/// description come from the skill's SKILL.md frontmatter.
fn installed_external() -> Vec<SkillInfo> {
    let bundled: std::collections::HashSet<&str> = SKILLS.iter().map(|s| s.id).collect();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for root in skills_roots() {
        let Ok(rd) = std::fs::read_dir(&root) else { continue };
        for e in rd.filter_map(|e| e.ok()) {
            let dir = e.path();
            if !dir.join(MARKER).exists() {
                continue;
            }
            let id = e.file_name().to_string_lossy().to_string();
            if bundled.contains(id.as_str()) || !seen.insert(id.clone()) {
                continue;
            }
            let (name, description) = read_skill_meta(&dir).unwrap_or_else(|| (id.clone(), String::new()));
            out.push(SkillInfo {
                id,
                name,
                description,
                enabled: true,
                builtin: false,
            });
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Pull `name` + `description` from a skill dir's `SKILL.md` YAML frontmatter.
fn read_skill_meta(dir: &Path) -> Option<(String, String)> {
    let text = std::fs::read_to_string(dir.join("SKILL.md")).ok()?;
    let mut name: Option<String> = None;
    let mut desc: Option<String> = None;
    // Only scan the leading frontmatter block (between the first pair of `---`).
    let mut in_fm = false;
    for line in text.lines() {
        let t = line.trim();
        if t == "---" {
            if in_fm {
                break;
            }
            in_fm = true;
            continue;
        }
        if !in_fm {
            // Tolerate a SKILL.md with no frontmatter — fall back to the H1.
            if let Some(h1) = t.strip_prefix("# ") {
                name.get_or_insert_with(|| h1.trim().to_string());
            }
            continue;
        }
        if let Some(v) = t.strip_prefix("name:") {
            name = Some(v.trim().trim_matches(|c| c == '"' || c == '\'').to_string());
        } else if let Some(v) = t.strip_prefix("description:") {
            desc = Some(v.trim().trim_matches(|c| c == '"' || c == '\'').to_string());
        }
    }
    let name = name.filter(|s| !s.is_empty())?;
    Some((name, desc.unwrap_or_default()))
}
