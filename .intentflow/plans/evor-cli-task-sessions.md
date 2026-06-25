# Plan: `evor` CLI + task↔session lifecycle

**Status:** ⬜ planned · **Owner:** Rabin · **Tracks roadmap:** "Tasks & daily
planning" (Phase 2 successor) + "Live multi-window sync"

> Brainstormed 2026-06-25. Decisions locked: **unified `evor` binary + RPC**;
> task created `todo`, **auto→`doing` on session attach**.

## Why
Two task systems fight each other today:
- **Local IDE board** (`tasktrack.rs` + `store.rs`): agent reports via brittle
  `echo '{...}' >> $EVORIDE_TASKS`; three env vars (`EVORIDE_TASKS`,
  `EVORIDE_PROJECT_TASKS`, `EVORIDE_EDITS`).
- **Cloud `evor` CLI** (`~/.claude/skills/evor/SKILL.md`): multiplayer binary
  (`evor tasks list`, `evor sessions …`) → evor.dev.

The agent sees both + echo-hacks → confusion. Worse, `store.add_task` defaults
`status="todo"` while the skill block claims the new task is "in-progress" →
ambiguous from birth. Sessions that die mid-work leave tasks stuck in `doing`,
so the board fills with semi-worked junk. Play/launch spawns a **fresh**
terminal instead of reusing the task's session.

## The fix (5 parts)

### 1. One `evor` binary, context-aware
Single binary on PATH (bundled as a Tauri sidecar resource, like the `dist`
bundle for Mobile access in v0.2.1). Mode auto-detected:
- `EVORIDE_AGENT_ID` set in the pty env → **local mode** (talk to the running
  IDE over RPC).
- else → **cloud mode** (today's evor.dev behavior, unchanged).

Local subcommands replace every `echo >> $EVORIDE_*`:
```
evor task list [--status todo]      # was: cat $EVORIDE_PROJECT_TASKS
evor task new "<title>" [--todo]    # default: doing + bound to THIS session
evor task start|done|block <id>
evor task note "<...>"  /  evor task step done "<title>"
evor edit <file> --info "<...>"     # was: echo >> $EVORIDE_EDITS
```

**Transport:** loopback / unix-socket RPC to the already-running app (reuse the
daemon foundation in `bin/evor-daemon.rs` + `remote.rs` / `serve.rs`). The
socket path/port is injected as an env var (e.g. `EVORIDE_RPC`) alongside
`EVORIDE_AGENT_ID`. **Fallback:** if the app isn't reachable, append the same
log files as today — so nothing breaks offline / in headless spawns.

**Security:** RPC is loopback-only + pairing-token gated; every file path the
binary forwards goes through `guard::confine(project_roots, path)`; run-config
trust rules (`run::command_is_trusted`) untouched. Treat anything the binary
relays as untrusted (it can carry agent/model output).

### 2. Skill discovery (slim the managed block)
Shrink `tasktrack::skill_block()` from ~25 lines of echo recipes to ~3:
> "You have an `evor` CLI for tasks in this project. `evor task list` to see
> work, `evor task new` to start something, `evor task done` when finished. See
> `evor task --help`."

The binary self-documents → one source of truth instead of duplicated prose in
CLAUDE.md + AGENTS.md + SKILL.md.

### 3. Lifecycle — stop the pile-up
State machine: `todo → doing → review → done`, plus `blocked`, `abandoned`.
- **Create = `todo`.** **Attaching a session auto-flips `todo → doing`.** (locked
  decision) — todo when queued, doing the moment a terminal picks it up.
- **One active (`doing`) task per session** invariant — an agent can't leave 5
  half-done.
- **Stale reconciliation (the "closed by default" case):** on `pty-exit`, if the
  linked task is still `doing` and never got `done` → flip to `todo` + a `stale`
  flag + note "session exited without finishing." Surfaces in a *Needs
  attention* bucket, not silently rotting as `doing`.
- **Consolidation:** reuse existing dup-detection (`appendTaskNote` on
  `dup.hit`); add a stale/dup bucket with bulk **archive / merge / abandon**.

### 4. One terminal per task (play / goto reuse)
`Task.agent_id` already exists — make it authoritative:
- ▶ / "go to" a task → if `agent_id` session **alive** → focus it; if **stopped**
  → `resumeExisting(agent_id)` (resume in place — already implemented); only
  **spawn + bind** if no session exists.
- Today `App.tsx` `launch()` always spawns fresh via `pendingWorkRef`. Change it
  to check `task.agent_id` first. Surgical.

### 5. Resume integration
- `evor task done` → mark the agent record so the resume list shows
  "✓ done — <title>" and **excludes it from `resumeProject`** auto-continue
  (don't reopen finished work).
- `doing` / `blocked` agents still resume + get the "continue where you left
  off" nudge.
- Stale tasks surface in resume as "⚠ unfinished — <title>" so nothing silently
  disappears.

## Data-model touches
- `tasks`: add `stale` (bool/flag) + `closed_by` (agent/session id) + maybe
  `closed_commit`. Extend status enum to include `review | blocked | abandoned`
  (adapters already map to/from provider statuses).
- `agents`: derive resume-list label from the linked task's status (join, no new
  column strictly needed).

## Phases
1. **`evor` local binary + RPC + slim skill block** — biggest UX win; replaces
   echo-hacks. *(Medium)*
2. **Lifecycle:** create=`todo` / attach=`doing` / stale-on-exit reconcile.
   *(Small–Medium)*
3. **One-terminal-per-task** play/goto reuse in `App.tsx`. *(Small)*
4. **Consolidation bucket + resume status integration.** *(Medium)*

## Touch points (for whoever implements)
- `ide/src-tauri/src/bin/` — new `evor.rs` binary (+ `default-run` stays `ide`;
  add the binary to `tauri.conf.json` resources/sidecar).
- `session.rs` `spawn()` — inject `EVORIDE_RPC` + prepend sidecar dir to child
  `PATH`; on `pty-exit` trigger stale reconcile.
- `tasktrack.rs` — slim `skill_block()`; RPC ingest path beside the log-file
  ingest.
- `store.rs` — status enum + `stale`/`closed_by`; attach→doing transition.
- `remote.rs` / `serve.rs` — local RPC endpoints for the binary.
- `App.tsx` — `launch()` reuse via `task.agent_id`; resume-list labels;
  `resumeProject` skip-done.
