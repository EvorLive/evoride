//! Daily activity summaries. Derived (no LLM) from the persisted agent history:
//! agents created on a given day, grouped by project, with their titles — which
//! are themselves derived from the user's requests. Renders as Markdown for the
//! Home view.

use crate::store::{AgentRecord, Project, Store};
use std::collections::BTreeMap;

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

    if agents.is_empty() {
        out.push_str("No agent activity recorded for this day.\n");
        return out;
    }

    let total = agents.len();
    out.push_str(&format!(
        "You ran {} {} on {date}.\n",
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
