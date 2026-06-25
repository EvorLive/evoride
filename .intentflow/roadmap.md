# EvorIDE roadmap (tracked plan)

The committed plan for EvorIDE, so the *why* and the *next* live in the repo and
any IDE opening this project sees them. Status: ✅ done · 🚧 in progress ·
⬜ planned.

## Now / next
- 🚧 **AI run setup** — generate a per-project run config via an agent, stored at
  `~/.evoride/{project_id}/runinfo.json`; fixes Docker/monorepo/custom run.
  → [plan](plans/ai-run-config.md)
- ⬜ **Opened agent ≠ waiting** — suppress the "waiting" badge for the agent you're
  actively viewing. *(quick)*
- ⬜ **Agent rename / title updates** — `set_agent_title` + inline rename; optional
  auto-title from the Claude session. *(quick)*
- ⬜ **Cross-terminal notifications** — OS notification + in-app toast when a
  background/other-window agent starts waiting (`tauri-plugin-notification`).
- ⬜ **Open from Git** — clone a repo URL and open it as a project.
- ⬜ **Tasks & daily planning** — a Tasks page (today/yesterday/unassigned), agents
  create tasks per project (Unassigned when not relatable), provider-agnostic for
  Notion/Jira/evor.live sync. → [plan](plans/tasks-planning.md)
- ⬜ **`evor` CLI + task↔session lifecycle** — unified context-aware `evor` binary
  (local RPC vs cloud) replacing echo-hacks; create=todo / attach=doing; stale
  reconcile on exit; one terminal per task (play/goto reuse); resume status.
  → [plan](plans/evor-cli-task-sessions.md)

## Bigger bets
- ⬜ **Cross-project memory in Claude** — reference another workspace project's
  intent docs + summary + edit log as context for the active agent.
- ⬜ **Jira integration** — two-way sync issues ↔ tasks.
- ⬜ **Live multi-window sync** — broadcast agent/workspace changes so all windows
  update instantly (they already share backend state + localStorage).
- ⬜ **Reminders** — manage reminders in the IDE with due-time notifications.
- ⬜ **Persistent agents** (tmux), **remote control / mobile**, **eterm GUI
  terminal**, **per-project permission profiles** — see README roadmap.

## Done (recent)
- ✅ Smart waiting detection (regex + LLM judge, content-cached, batched), parsed
  question + choices, reply-as-text for prose questions.
- ✅ Settings dialog (theme, always-on-top opt-in, AI analyzer, agent CLIs +
  paths), SQLite store, lazy workspace restore, daily summary (history + accuracy).
- ✅ Branding (EvorIDE name + icon), CI/CD + Pages + signed-release docs.
