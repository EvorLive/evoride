//! Persistent project workspace: projects, agent history, and tasks, saved as
//! JSON in the app data dir. This is what makes the IDE project-centric and
//! lets agents be resumed across restarts.

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

#[derive(Debug, Default, Serialize, Deserialize)]
struct Data {
    projects: Vec<Project>,
    agents: Vec<AgentRecord>,
    tasks: Vec<Task>,
}

pub struct Store {
    path: PathBuf,
    data: Mutex<Data>,
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
    /// Load from disk; any agents previously marked running are reset to exited
    /// (their ptys did not survive the restart).
    pub fn load(path: PathBuf) -> Self {
        let mut data: Data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        for a in &mut data.agents {
            if a.status == "running" {
                a.status = "exited".into();
            }
        }
        Self {
            path,
            data: Mutex::new(data),
        }
    }

    /// Write atomically (tmp + rename) so multiple IDE windows/processes can't
    /// observe or leave a half-written store file.
    fn save(&self, data: &Data) {
        if let Ok(json) = serde_json::to_string_pretty(data) {
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
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
        let mut data = self.data.lock().unwrap();
        // Dedupe by path.
        if let Some(existing) = data.projects.iter().find(|p| p.path == path) {
            return existing.clone();
        }
        let project = Project {
            id: gen_id("proj"),
            name,
            path: path.to_string(),
            created_at: now(),
        };
        data.projects.push(project.clone());
        self.save(&data);
        project
    }

    pub fn list_projects(&self) -> Vec<Project> {
        self.data.lock().unwrap().projects.clone()
    }

    pub fn get_project(&self, id: &str) -> Option<Project> {
        self.data
            .lock()
            .unwrap()
            .projects
            .iter()
            .find(|p| p.id == id)
            .cloned()
    }

    pub fn remove_project(&self, id: &str) {
        let mut data = self.data.lock().unwrap();
        data.projects.retain(|p| p.id != id);
        data.agents.retain(|a| a.project_id != id);
        data.tasks.retain(|t| t.project_id != id);
        self.save(&data);
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
        let mut data = self.data.lock().unwrap();
        data.agents.push(rec.clone());
        self.save(&data);
        rec
    }

    pub fn set_agent_status(&self, id: &str, status: &str) {
        let mut data = self.data.lock().unwrap();
        if let Some(a) = data.agents.iter_mut().find(|a| a.id == id) {
            a.status = status.to_string();
            self.save(&data);
        }
    }

    /// Permanently remove an agent record.
    pub fn delete_agent(&self, id: &str) {
        let mut data = self.data.lock().unwrap();
        data.agents.retain(|a| a.id != id);
        self.save(&data);
    }

    pub fn get_agent(&self, id: &str) -> Option<AgentRecord> {
        self.data
            .lock()
            .unwrap()
            .agents
            .iter()
            .find(|a| a.id == id)
            .cloned()
    }

    /// Resolve and forget — only used to verify persistence in tests.
    #[cfg(test)]
    fn agent_count(&self) -> usize {
        self.data.lock().unwrap().agents.len()
    }

    /// Every agent record across all projects (for daily-summary digests).
    pub fn list_all(&self) -> Vec<AgentRecord> {
        self.data.lock().unwrap().agents.clone()
    }

    /// All currently-running agents across every project (for the project rail).
    pub fn list_running(&self) -> Vec<AgentRecord> {
        self.data
            .lock()
            .unwrap()
            .agents
            .iter()
            .filter(|a| a.status == "running")
            .cloned()
            .collect()
    }

    /// Agents for a project, newest first. Iterating in reverse before a stable
    /// sort makes insertion order the tiebreaker when timestamps collide.
    pub fn list_agents(&self, project_id: &str) -> Vec<AgentRecord> {
        let mut v: Vec<AgentRecord> = self
            .data
            .lock()
            .unwrap()
            .agents
            .iter()
            .rev()
            .filter(|a| a.project_id == project_id)
            .cloned()
            .collect();
        v.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        v
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
        let mut data = self.data.lock().unwrap();
        data.tasks.push(task.clone());
        self.save(&data);
        task
    }

    pub fn update_task(&self, id: &str, status: &str) {
        let mut data = self.data.lock().unwrap();
        if let Some(t) = data.tasks.iter_mut().find(|t| t.id == id) {
            t.status = status.to_string();
            self.save(&data);
        }
    }

    pub fn delete_task(&self, id: &str) {
        let mut data = self.data.lock().unwrap();
        data.tasks.retain(|t| t.id != id);
        self.save(&data);
    }

    pub fn list_tasks(&self, project_id: &str) -> Vec<Task> {
        let mut v: Vec<Task> = self
            .data
            .lock()
            .unwrap()
            .tasks
            .iter()
            .filter(|t| t.project_id == project_id)
            .cloned()
            .collect();
        v.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        std::env::temp_dir().join(format!("eterm-ide-test-{}.json", gen_id("t")))
    }

    #[test]
    fn projects_agents_tasks_roundtrip_and_persist() {
        let path = tmp();
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

        let _ = std::fs::remove_file(path);
    }
}
