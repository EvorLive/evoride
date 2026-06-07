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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub title: String,
    /// "todo" | "doing" | "done"
    pub status: String,
    pub agent_id: Option<String>,
    pub created_at: i64,
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
                 id          TEXT PRIMARY KEY,
                 project_id  TEXT NOT NULL,
                 title       TEXT NOT NULL,
                 status      TEXT NOT NULL,
                 agent_id    TEXT,
                 created_at  INTEGER NOT NULL
             );",
        );
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

    pub fn add_task(&self, project_id: &str, title: &str, agent_id: Option<String>) -> Task {
        let task = Task {
            id: gen_id("task"),
            project_id: project_id.to_string(),
            title: title.to_string(),
            status: "todo".into(),
            agent_id,
            created_at: now(),
        };
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO tasks (id, project_id, title, status, agent_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                task.id,
                task.project_id,
                task.title,
                task.status,
                task.agent_id,
                task.created_at
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

    pub fn delete_task(&self, id: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM tasks WHERE id = ?1", params![id]);
    }

    pub fn list_tasks(&self, project_id: &str) -> Vec<Task> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, project_id, title, status, agent_id, created_at
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

        let t = store.add_task(&p.id, "ship it", Some(a.id.clone()));
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
