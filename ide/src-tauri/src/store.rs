//! Persistent project workspace: projects, agent history, and tasks, saved in a
//! SQLite database in the app data dir. This is what makes the IDE
//! project-centric and lets agents be resumed across restarts.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: i64,
}

/// A historical (or live) agent within a project. `id` doubles as the live pty
/// id while running.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRecord {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub command: String,
    pub cwd: String,
    pub created_at: i64,
    /// "running" | "exited"
    pub status: String,
}

/// One step in a task's breakdown (an architect's plan, tracked individually).
/// Maps to a Jira subtask / Notion checklist item / evor.live subtask.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub id: String,
    pub title: String,
    /// "todo" | "doing" | "done"
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    /// Owning project, or "" when unassigned (e.g. an agent couldn't relate it).
    pub project_id: String,
    pub title: String,
    /// "todo" | "doing" | "done"
    pub status: String,
    pub agent_id: Option<String>,
    pub created_at: i64,
    /// Longer free-text detail (provider "description"/"body"); maps to Jira
    /// description, Notion page body, evor.live task detail.
    #[serde(default)]
    pub description: Option<String>,
    /// Architect breakdown — ordered, individually-tracked steps.
    #[serde(default)]
    pub steps: Vec<Step>,
    /// The day it's planned for (YYYY-MM-DD), for daily planning.
    #[serde(default)]
    pub planned_for: Option<String>,
    /// Where it came from — "local" | "jira" | "notion" | "evor".
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub external_id: Option<String>,
    #[serde(default)]
    pub external_url: Option<String>,
}

/// Legacy on-disk JSON shape, used only for the one-time import into SQLite.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Data {
    projects: Vec<Project>,
    agents: Vec<AgentRecord>,
    tasks: Vec<Task>,
}

pub struct Store {
    conn: Mutex<Connection>,
}

static COUNTER: AtomicU64 = AtomicU64::new(1);

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn gen_id(prefix: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{:x}{:x}", now(), n)
}

impl Store {
    /// Open the SQLite store; any agents previously marked running are reset to
    /// exited (their ptys did not survive the restart). The db path is derived
    /// from `path` (same directory, `store.db`). If the db is new and a legacy
    /// JSON file exists at `path`, its contents are imported once.
    pub fn load(path: PathBuf) -> Self {
        let db_path = path.with_file_name("store.db");
        let conn = Connection::open(&db_path)
            .unwrap_or_else(|_| Connection::open_in_memory().expect("open in-memory sqlite"));

        Self::init_schema(&conn);

        // One-time migration from the legacy JSON store, best-effort.
        if Self::is_empty(&conn) {
            if let Ok(s) = std::fs::read_to_string(&path) {
                if let Ok(data) = serde_json::from_str::<Data>(&s) {
                    Self::import_legacy(&conn, &data);
                }
            }
        }

        // Reset stale "running" agents to "exited".
        let _ = conn.execute(
            "UPDATE agents SET status = 'exited' WHERE status = 'running'",
            [],
        );

        Self {
            conn: Mutex::new(conn),
        }
    }

    fn init_schema(conn: &Connection) {
        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS projects (
                 id          TEXT PRIMARY KEY,
                 name        TEXT NOT NULL,
                 path        TEXT NOT NULL,
                 created_at  INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS agents (
                 id          TEXT PRIMARY KEY,
                 project_id  TEXT NOT NULL,
                 title       TEXT NOT NULL,
                 command     TEXT NOT NULL,
                 cwd         TEXT NOT NULL,
                 created_at  INTEGER NOT NULL,
                 status      TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS tasks (
                 id           TEXT PRIMARY KEY,
                 project_id   TEXT NOT NULL,
                 title        TEXT NOT NULL,
                 status       TEXT NOT NULL,
                 agent_id     TEXT,
                 created_at   INTEGER NOT NULL,
                 planned_for  TEXT,
                 source       TEXT,
                 external_id  TEXT,
                 external_url TEXT,
                 description  TEXT,
                 steps        TEXT
             );",
        );
        // Add the planning/sync columns to pre-existing task tables (ignore the
        // "duplicate column" error on subsequent runs).
        for col in [
            "planned_for TEXT",
            "source TEXT",
            "external_id TEXT",
            "external_url TEXT",
            "description TEXT",
            "steps TEXT",
        ] {
            let _ = conn.execute(&format!("ALTER TABLE tasks ADD COLUMN {col}"), []);
        }
    }

    fn is_empty(conn: &Connection) -> bool {
        let count: i64 = conn
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM projects) +
                    (SELECT COUNT(*) FROM agents) +
                    (SELECT COUNT(*) FROM tasks)",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        count == 0
    }

    fn import_legacy(conn: &Connection, data: &Data) {
        for p in &data.projects {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO projects (id, name, path, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![p.id, p.name, p.path, p.created_at],
            );
        }
        for a in &data.agents {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO agents
                    (id, project_id, title, command, cwd, created_at, status)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![a.id, a.project_id, a.title, a.command, a.cwd, a.created_at, a.status],
            );
        }
        for t in &data.tasks {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO tasks
                    (id, project_id, title, status, agent_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![t.id, t.project_id, t.title, t.status, t.agent_id, t.created_at],
            );
        }
    }

    // --- row mappers ---

    fn map_project(row: &rusqlite::Row) -> rusqlite::Result<Project> {
        Ok(Project {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
            created_at: row.get(3)?,
        })
    }

    fn map_agent(row: &rusqlite::Row) -> rusqlite::Result<AgentRecord> {
        Ok(AgentRecord {
            id: row.get(0)?,
            project_id: row.get(1)?,
            title: row.get(2)?,
            command: row.get(3)?,
            cwd: row.get(4)?,
            created_at: row.get(5)?,
            status: row.get(6)?,
        })
    }

    fn map_task(row: &rusqlite::Row) -> rusqlite::Result<Task> {
        Ok(Task {
            id: row.get(0)?,
            project_id: row.get(1)?,
            title: row.get(2)?,
            status: row.get(3)?,
            agent_id: row.get(4)?,
            created_at: row.get(5)?,
            planned_for: row.get(6)?,
            source: row.get::<_, Option<String>>(7)?.unwrap_or_else(|| "local".into()),
            external_id: row.get(8)?,
            external_url: row.get(9)?,
            description: row.get(10)?,
            steps: row
                .get::<_, Option<String>>(11)?
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default(),
        })
    }

    // --- projects ---

    pub fn add_project(&self, path: &str) -> Project {
        let name = path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or(path)
            .to_string();
        let conn = self.conn.lock().unwrap();
        // Dedupe by path.
        if let Ok(existing) = conn.query_row(
            "SELECT id, name, path, created_at FROM projects WHERE path = ?1 LIMIT 1",
            params![path],
            Self::map_project,
        ) {
            return existing;
        }
        let project = Project {
            id: gen_id("proj"),
            name,
            path: path.to_string(),
            created_at: now(),
        };
        let _ = conn.execute(
            "INSERT INTO projects (id, name, path, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![project.id, project.name, project.path, project.created_at],
        );
        project
    }

    pub fn list_projects(&self) -> Vec<Project> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare("SELECT id, name, path, created_at FROM projects") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = match stmt.query_map([], Self::map_project) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        rows.filter_map(|r| r.ok()).collect()
    }

    pub fn get_project(&self, id: &str) -> Option<Project> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, path, created_at FROM projects WHERE id = ?1",
            params![id],
            Self::map_project,
        )
        .ok()
    }

    pub fn remove_project(&self, id: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM projects WHERE id = ?1", params![id]);
        let _ = conn.execute("DELETE FROM agents WHERE project_id = ?1", params![id]);
        let _ = conn.execute("DELETE FROM tasks WHERE project_id = ?1", params![id]);
    }

    // --- agents ---

    pub fn add_agent(
        &self,
        project_id: &str,
        title: &str,
        command: &str,
        cwd: &str,
    ) -> AgentRecord {
        let rec = AgentRecord {
            id: gen_id("agent"),
            project_id: project_id.to_string(),
            title: title.to_string(),
            command: command.to_string(),
            cwd: cwd.to_string(),
            created_at: now(),
            status: "running".into(),
        };
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO agents (id, project_id, title, command, cwd, created_at, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                rec.id,
                rec.project_id,
                rec.title,
                rec.command,
                rec.cwd,
                rec.created_at,
                rec.status
            ],
        );
        rec
    }

    pub fn set_agent_status(&self, id: &str, status: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE agents SET status = ?1 WHERE id = ?2",
            params![status, id],
        );
    }

    pub fn set_agent_title(&self, id: &str, title: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE agents SET title = ?1 WHERE id = ?2",
            params![title, id],
        );
    }

    /// Permanently remove an agent record.
    pub fn delete_agent(&self, id: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM agents WHERE id = ?1", params![id]);
    }

    pub fn get_agent(&self, id: &str) -> Option<AgentRecord> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, project_id, title, command, cwd, created_at, status
             FROM agents WHERE id = ?1",
            params![id],
            Self::map_agent,
        )
        .ok()
    }

    /// Resolve and forget — only used to verify persistence in tests.
    #[cfg(test)]
    fn agent_count(&self) -> usize {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM agents", [], |r| r.get::<_, i64>(0))
            .unwrap_or(0) as usize
    }

    /// Every agent record across all projects (for daily-summary digests).
    pub fn list_all(&self) -> Vec<AgentRecord> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, project_id, title, command, cwd, created_at, status FROM agents",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = match stmt.query_map([], Self::map_agent) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        rows.filter_map(|r| r.ok()).collect()
    }

    /// All currently-running agents across every project (for the project rail).
    pub fn list_running(&self) -> Vec<AgentRecord> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, project_id, title, command, cwd, created_at, status
             FROM agents WHERE status = 'running'",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = match stmt.query_map([], Self::map_agent) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        rows.filter_map(|r| r.ok()).collect()
    }

    /// Agents for a project, newest first. Ties on `created_at` are broken by
    /// insertion order (descending rowid) to match the previous behavior.
    pub fn list_agents(&self, project_id: &str) -> Vec<AgentRecord> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, project_id, title, command, cwd, created_at, status
             FROM agents WHERE project_id = ?1
             ORDER BY created_at DESC, rowid DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = match stmt.query_map(params![project_id], Self::map_agent) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        rows.filter_map(|r| r.ok()).collect()
    }

    // --- tasks ---

    pub fn add_task(
        &self,
        project_id: &str,
        title: &str,
        agent_id: Option<String>,
        planned_for: Option<String>,
        description: Option<String>,
    ) -> Task {
        let task = Task {
            id: gen_id("task"),
            project_id: project_id.to_string(),
            title: title.to_string(),
            status: "todo".into(),
            agent_id,
            created_at: now(),
            description,
            steps: Vec::new(),
            planned_for,
            source: "local".into(),
            external_id: None,
            external_url: None,
        };
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO tasks (id, project_id, title, status, agent_id, created_at, planned_for, source, description)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                task.id,
                task.project_id,
                task.title,
                task.status,
                task.agent_id,
                task.created_at,
                task.planned_for,
                task.source,
                task.description
            ],
        );
        task
    }

    pub fn update_task(&self, id: &str, status: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE tasks SET status = ?1 WHERE id = ?2",
            params![status, id],
        );
    }

    pub fn set_task_description(&self, id: &str, description: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE tasks SET description = ?1 WHERE id = ?2",
            params![description, id],
        );
    }

    /// Append a line to a task's description (used when merging a duplicate's
    /// requirement into an existing task).
    pub fn append_task_description(&self, id: &str, note: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE tasks SET description = CASE \
             WHEN description IS NULL OR description = '' THEN ?1 \
             ELSE description || char(10) || ?1 END WHERE id = ?2",
            params![note, id],
        );
    }

    /// Link a task to the agent currently working it (for status round-tripping).
    pub fn set_task_agent(&self, id: &str, agent_id: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE tasks SET agent_id = ?1 WHERE id = ?2",
            params![agent_id, id],
        );
    }

    /// Replace a task's breakdown steps (stored as JSON).
    pub fn set_task_steps(&self, id: &str, steps: &[Step]) {
        let json = serde_json::to_string(steps).unwrap_or_else(|_| "[]".into());
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE tasks SET steps = ?1 WHERE id = ?2",
            params![json, id],
        );
    }

    /// Fetch a single task by id.
    pub fn get_task(&self, id: &str) -> Option<Task> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, project_id, title, status, agent_id, created_at, planned_for, source, external_id, external_url, description, steps
             FROM tasks WHERE id = ?1",
            params![id],
            Self::map_task,
        )
        .ok()
    }

    /// Find a task by its external source + id (e.g. a Jira issue key) — used to
    /// tell whether an issue has already been imported.
    pub fn task_by_external_id(&self, source: &str, external_id: &str) -> Option<Task> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, project_id, title, status, agent_id, created_at, planned_for, source, external_id, external_url, description, steps
             FROM tasks WHERE source = ?1 AND external_id = ?2 LIMIT 1",
            params![source, external_id],
            Self::map_task,
        )
        .ok()
    }

    /// Schedule a task for a given day (YYYY-MM-DD), e.g. "import to today".
    pub fn set_task_planned_for(&self, id: &str, day: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE tasks SET planned_for = ?1 WHERE id = ?2",
            params![day, id],
        );
    }

    /// Link a local task to an external issue (used when pushing a task UP to
    /// Jira creates a new issue).
    pub fn set_task_external(&self, id: &str, source: &str, external_id: &str, external_url: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE tasks SET source = ?1, external_id = ?2, external_url = ?3 WHERE id = ?4",
            params![source, external_id, external_url, id],
        );
    }

    /// The task currently linked to an agent (most recent), if any.
    pub fn task_for_agent(&self, agent_id: &str) -> Option<Task> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, project_id, title, status, agent_id, created_at, planned_for, source, external_id, external_url, description, steps
             FROM tasks WHERE agent_id = ?1 ORDER BY created_at DESC LIMIT 1",
            params![agent_id],
            Self::map_task,
        )
        .ok()
    }

    /// Re-assign a task to a project ("" = unassigned).
    pub fn set_task_project(&self, id: &str, project_id: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE tasks SET project_id = ?1 WHERE id = ?2",
            params![project_id, id],
        );
    }

    pub fn delete_task(&self, id: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM tasks WHERE id = ?1", params![id]);
    }

    /// Every task across all projects (for the Tasks page).
    pub fn list_all_tasks(&self) -> Vec<Task> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, project_id, title, status, agent_id, created_at, planned_for, source, external_id, external_url, description, steps
             FROM tasks ORDER BY created_at DESC, rowid DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = match stmt.query_map([], Self::map_task) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        rows.filter_map(|r| r.ok()).collect()
    }

    pub fn list_tasks(&self, project_id: &str) -> Vec<Task> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, project_id, title, status, agent_id, created_at, planned_for, source, external_id, external_url, description, steps
             FROM tasks WHERE project_id = ?1
             ORDER BY created_at ASC, rowid ASC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = match stmt.query_map(params![project_id], Self::map_task) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        rows.filter_map(|r| r.ok()).collect()
    }

    /// Insert or update a task that originated from an external source, keyed by
    /// (source, external_id). On update we refresh title/status/url (and
    /// description if provided) but PRESERVE the local id, steps, agent link, and
    /// project assignment (the user may have re-homed it). Returns (task, inserted).
    pub fn upsert_external_task(
        &self,
        source: &str,
        external_id: &str,
        external_url: Option<&str>,
        project_id: &str,
        title: &str,
        status: &str,
        description: Option<&str>,
    ) -> Option<(Task, bool)> {
        let id = {
            let conn = self.conn.lock().unwrap();
            let existing: Option<String> = conn
                .query_row(
                    "SELECT id FROM tasks WHERE source = ?1 AND external_id = ?2 LIMIT 1",
                    params![source, external_id],
                    |r| r.get(0),
                )
                .ok();
            match existing {
                Some(id) => {
                    let _ = conn.execute(
                        "UPDATE tasks SET title = ?1, status = ?2, external_url = ?3, \
                         description = COALESCE(?4, description) WHERE id = ?5",
                        params![title, status, external_url, description, id],
                    );
                    (id, false)
                }
                None => {
                    let id = gen_id("task");
                    let _ = conn.execute(
                        "INSERT INTO tasks (id, project_id, title, status, agent_id, created_at, source, external_id, external_url, description)
                         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9)",
                        params![id, project_id, title, status, now(), source, external_id, external_url, description],
                    );
                    (id, true)
                }
            }
        };
        self.get_task(&id.0).map(|t| (t, id.1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        std::env::temp_dir().join(format!("eterm-ide-test-{}/store.json", gen_id("t")))
    }

    #[test]
    fn projects_agents_tasks_roundtrip_and_persist() {
        let path = tmp();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let store = Store::load(path.clone());

        let p = store.add_project("/Users/me/proj-alpha");
        assert_eq!(p.name, "proj-alpha");
        // Dedupe by path.
        let p2 = store.add_project("/Users/me/proj-alpha");
        assert_eq!(p.id, p2.id);
        assert_eq!(store.list_projects().len(), 1);

        let a = store.add_agent(&p.id, "api", "claude", &p.path);
        assert_eq!(a.status, "running");
        store.add_agent(&p.id, "web", "/bin/zsh", &p.path);
        assert_eq!(store.list_agents(&p.id).len(), 2);
        // newest first
        assert_eq!(store.list_agents(&p.id)[0].title, "web");

        store.set_agent_status(&a.id, "exited");
        assert_eq!(store.get_agent(&a.id).unwrap().status, "exited");

        let t = store.add_task(&p.id, "ship it", Some(a.id.clone()), None, None);
        store.update_task(&t.id, "doing");
        assert_eq!(store.list_tasks(&p.id)[0].status, "doing");
        store.delete_task(&t.id);
        assert!(store.list_tasks(&p.id).is_empty());

        // Reload from disk: running agents reset to exited, data persists.
        let reloaded = Store::load(path.clone());
        assert_eq!(reloaded.list_projects().len(), 1);
        assert_eq!(reloaded.agent_count(), 2);
        assert!(reloaded.list_agents(&p.id).iter().all(|a| a.status == "exited"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
