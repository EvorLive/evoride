//! Daily activity summaries. Derived (no LLM) from the persisted agent history:
//! agents created on a given day, grouped by project, with their titles — which
//! are themselves derived from the user's requests. Renders as Markdown for the
//! Home view.

use crate::store::{AgentRecord, Project, Store};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

fn fmt_k(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1000 {
        format!("{:.0}k", n as f64 / 1000.0)
    } else {
        n.to_string()
    }
}

/// Read a day's Claude token + activity totals from ~/.claude/stats-cache.json.
/// Returns (markdown lines, ...). The cache is recomputed periodically, so a
/// very recent day may not be present yet — we flag staleness.
fn claude_day_stats(date: &str) -> Option<String> {
    let home = crate::fs::home()?;
    let text = std::fs::read_to_string(Path::new(&home).join(".claude").join("stats-cache.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let last = v.get("lastComputedDate").and_then(|x| x.as_str()).unwrap_or("");

    let mut tokens = 0u64;
    let mut models: Vec<(String, u64)> = Vec::new();
    if let Some(arr) = v.get("dailyModelTokens").and_then(|x| x.as_array()) {
        for e in arr {
            if e.get("date").and_then(|d| d.as_str()) == Some(date) {
                if let Some(tbm) = e.get("tokensByModel").and_then(|x| x.as_object()) {
                    for (m, t) in tbm {
                        let tv = t.as_u64().unwrap_or(0);
                        tokens += tv;
                        models.push((m.clone(), tv));
                    }
                }
            }
        }
    }
    let (mut messages, mut sessions) = (0u64, 0u64);
    if let Some(arr) = v.get("dailyActivity").and_then(|x| x.as_array()) {
        for e in arr {
            if e.get("date").and_then(|d| d.as_str()) == Some(date) {
                messages = e.get("messageCount").and_then(|x| x.as_u64()).unwrap_or(0);
                sessions = e.get("sessionCount").and_then(|x| x.as_u64()).unwrap_or(0);
            }
        }
    }

    if tokens == 0 && messages == 0 {
        // No computed data for this day. If it's newer than the cache, say so.
        if date > last {
            return Some(format!(
                "- Claude tokens: not computed yet (stats cache as of {last})\n"
            ));
        }
        return None;
    }

    models.sort_by(|a, b| b.1.cmp(&a.1));
    let by_model = models
        .iter()
        .map(|(m, t)| format!("{} {}", short_model(m), fmt_k(*t)))
        .collect::<Vec<_>>()
        .join(", ");
    let mut s = format!("- Claude tokens: ~{}", fmt_k(tokens));
    if !by_model.is_empty() {
        s.push_str(&format!(" ({by_model})"));
    }
    if date > last {
        s.push_str(" _(cache may lag)_");
    }
    s.push('\n');
    s.push_str(&format!("- Claude sessions: {sessions} · messages: {messages}\n"));
    // The subscription usage %/limit + reset is internal to Claude Code (`/usage`)
    // and isn't readable from disk — be honest rather than fabricate it.
    s.push_str("- Usage limit %/reset: run `/usage` in Claude (not exposed on disk)\n");
    Some(s)
}

fn short_model(m: &str) -> String {
    m.replace("claude-", "").replace("-20", " 20")
}

/// Lines added/removed across the given repos for `date` (from that day's commits).
fn lines_changed(paths: &[String], date: &str) -> (u64, u64, usize) {
    let (mut add, mut del, mut repos) = (0u64, 0u64, 0usize);
    let since = format!("--since={date} 00:00:00");
    let until = format!("--until={date} 23:59:59");
    for p in paths {
        let out = Command::new("git")
            .arg("-C")
            .arg(p)
            .args(["log", &since, &until, "--numstat", "--pretty=tformat:"])
            .output();
        if let Ok(o) = out {
            if o.status.success() {
                let text = String::from_utf8_lossy(&o.stdout);
                let mut any = false;
                for line in text.lines() {
                    let mut it = line.split('\t');
                    if let (Some(a), Some(d)) = (it.next(), it.next()) {
                        if let (Ok(a), Ok(d)) = (a.parse::<u64>(), d.parse::<u64>()) {
                            add += a;
                            del += d;
                            any = true;
                        }
                    }
                }
                if any {
                    repos += 1;
                }
            }
        }
    }
    (add, del, repos)
}

/// "At a glance" metrics for `date`: projects, lines changed, Claude tokens/usage.
fn metrics_block(store: &Store, projects: &[Project], date: &str) -> String {
    let mut pids: Vec<String> = store
        .list_all()
        .into_iter()
        .filter(|a| civil_date(a.created_at) == date)
        .map(|a| a.project_id)
        .collect();
    pids.sort();
    pids.dedup();
    let paths: Vec<String> = pids
        .iter()
        .filter_map(|id| projects.iter().find(|p| &p.id == id).map(|p| p.path.clone()))
        .collect();
    let names: Vec<String> = pids
        .iter()
        .filter_map(|id| projects.iter().find(|p| &p.id == id).map(|p| p.name.clone()))
        .collect();

    let (add, del, repos) = lines_changed(&paths, date);

    let mut out = String::from("**At a glance**\n\n");
    out.push_str(&format!(
        "- Projects: {}{}\n",
        pids.len(),
        if names.is_empty() {
            String::new()
        } else {
            format!(" ({})", names.join(", "))
        }
    ));
    out.push_str(&format!(
        "- Lines changed: +{add} / −{del} across {repos} repo{}\n",
        if repos == 1 { "" } else { "s" }
    ));
    if let Some(stats) = claude_day_stats(date) {
        out.push_str(&stats);
    }
    out.push('\n');
    out
}

/// Build a `claude -p` narrative from the metrics + titles. Cached per-day under
/// `cache_dir`. Returns an error if the `claude` CLI isn't available.
pub fn ai_summary(
    store: &Store,
    projects: &[Project],
    date: &str,
    cache_dir: &Path,
) -> Result<String, String> {
    let _ = std::fs::create_dir_all(cache_dir);
    let cache = cache_dir.join(format!("{date}-ai.md"));
    if let Ok(c) = std::fs::read_to_string(&cache) {
        if !c.trim().is_empty() {
            return Ok(c);
        }
    }
    let base = summary_for(store, projects, date);
    let prompt = format!(
        "Below is a developer's raw activity log for {date}. Write a short, friendly \
         daily-standup style summary (3–5 sentences): what they worked on, progress made, \
         and call out the key metrics (projects, lines changed, tokens). Be specific but \
         concise. Output plain prose, no preamble.\n\n{base}"
    );
    let out = Command::new("claude")
        .args(["-p", &prompt])
        .output()
        .map_err(|e| format!("the `claude` CLI isn't available: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !text.is_empty() {
        let _ = std::fs::write(&cache, &text);
    }
    Ok(text)
}

/// YYYY-MM-DD for a unix timestamp (UTC civil date, no chrono dependency).
fn civil_date(secs: i64) -> String {
    let days = secs.div_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant's days→civil algorithm (mirrors `intent.rs`).
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

/// Today's civil date as YYYY-MM-DD.
pub fn today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    civil_date(secs)
}

/// Distinct YYYY-MM-DD days that have any agent activity, newest first.
pub fn summary_dates(store: &Store) -> Vec<String> {
    let mut days: Vec<String> = store
        .list_all()
        .iter()
        .map(|a| civil_date(a.created_at))
        .collect();
    days.sort();
    days.dedup();
    days.reverse();
    days
}

/// Build a Markdown summary of what the user did on `date` (YYYY-MM-DD): agents
/// created that day grouped by project name, each title listed with a count.
pub fn summary_for(store: &Store, projects: &[Project], date: &str) -> String {
    let project_name: BTreeMap<String, String> = projects
        .iter()
        .map(|p| (p.id.clone(), p.name.clone()))
        .collect();

    let agents: Vec<AgentRecord> = store
        .list_all()
        .into_iter()
        .filter(|a| civil_date(a.created_at) == date)
        .collect();

    let mut out = format!("# {date}\n\n");
    out.push_str(&metrics_block(store, projects, date));

    if agents.is_empty() {
        out.push_str("_No agent sessions recorded for this day._\n");
        return out;
    }

    let total = agents.len();
    out.push_str(&format!(
        "## What you worked on\n\n{} {} run.\n",
        total,
        if total == 1 { "session" } else { "sessions" }
    ));

    // Group titles by project; collapse duplicate titles into a count.
    let mut by_project: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for a in &agents {
        let name = project_name
            .get(&a.project_id)
            .cloned()
            .unwrap_or_else(|| "Unknown project".to_string());
        by_project.entry(name).or_default().push(a.title.clone());
    }

    for (project, titles) in &by_project {
        out.push_str(&format!("\n## {project}\n\n"));
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for t in titles {
            let title = if t.trim().is_empty() {
                "(untitled)".to_string()
            } else {
                t.clone()
            };
            *counts.entry(title).or_insert(0) += 1;
        }
        for (title, n) in &counts {
            if *n > 1 {
                out.push_str(&format!("- {title} ×{n}\n"));
            } else {
                out.push_str(&format!("- {title}\n"));
            }
        }
    }

    out
}
