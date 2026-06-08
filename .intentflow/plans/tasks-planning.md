# Plan: Tasks & daily planning (provider-agnostic)

**Status:** Phase 1 shipped · **Owner:** Rabin · **Tracks roadmap:** "Tasks on the dashboard" + "Jira"

> Phase 1 (2026-06-08): Tasks page (Today/Yesterday/Unassigned) + model extended
> (nullable project via "", `planned_for`, `source`, `external_id/url`) + quick-add
> + status cycle + assign-to-project. Rail "Tasks" nav + palette. Phases 2 (agent
> `EVORIDE_TASKS`) and 3 (Notion/Jira/evor adapters) next.

## Goal
A real **Tasks page** for planning your day: today + yesterday with status,
across all projects. **Agents can create tasks** for a project; if the project
can't be related, the task is **Unassigned** and you assign it (or open a project
and put it there). The model is structured so tasks can come from **Notion, Jira,
or evor.live** via adapters.

## Data model (extend the current Task)
Today: `{id, project_id, title, status, agent_id, created_at}`. Add:
- `project_id` becomes **nullable** → `null` = **Unassigned** (agent couldn't relate it).
- `planned_for` (`YYYY-MM-DD`, nullable) — the day it's planned (daily view).
- `source` (`local | jira | notion | evor`) — where it came from.
- `external_id`, `external_url` — for two-way sync + deep links.
- `notes` (optional).
Status stays `todo | doing | done` (mapped to/from provider statuses by adapters).

## Tasks page (new top-level view, next to Home / Workspace)
- **Today** / **Yesterday** columns (by `planned_for`, fallback `created_at`), each
  grouped by project, with status toggle (todo→doing→done) and a quick-add box.
- **Unassigned** lane: agent-created tasks with no project → "Assign to project…"
  (picker) or "Open project & assign".
- Carry-over: yesterday's unfinished tasks surface at the top of Today.

## Agents create tasks (mirror the edit-tracking mechanism)
- New env var `EVORIDE_TASKS` (like `EVORIDE_EDITS`) + a managed skill line telling
  the agent: to add a task, append one JSON line:
  `{"title": "...", "project": "<name or path, optional>", "status": "todo"}`.
- EvorIDE ingests the file: resolve `project` against known projects (by name or
  path). **No match → `project_id = null` (Unassigned)** so the user can relate it.

## Sync adapters (later, pluggable — this is the Jira answer)
A `TaskSource` trait: `list(query) -> Vec<Task>`, `create(Task)`, `update_status`.
- **evor.live** — easiest (own API); first real adapter once connected.
- **Notion** — DB query/create via Notion API token.
- **Jira** — read-only first (API token + JQL → tasks); two-way later (transitions
  are the hard part). Map Jira project→EvorIDE project, status→todo/doing/done.
Source/external fields make round-tripping + dedup possible.

## Phases
1. **Model + Tasks page** (local only): nullable project_id, `planned_for`, today/
   yesterday/unassigned, quick-add, assign-to-project. *(Medium)*
2. **Agent-created tasks** via `EVORIDE_TASKS` + project resolution. *(Small–Medium)*
3. **Adapters**: evor.live → Notion → Jira (read-only → two-way). *(per provider)*
