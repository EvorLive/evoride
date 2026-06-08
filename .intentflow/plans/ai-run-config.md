# Plan: AI-generated run configuration

**Status:** Implemented (v1) · **Owner:** Rabin · **Tracks roadmap item:** "AI run setup"

> v1 shipped 2026-06-08: backend `runinfo` read/precedence + `Service` port/url/
> ready_when + `run_setup_prompt`; `RunControl` "✨ Set up run" → spawns an agent
> with the instruction → polls for `runinfo.json` → loads + auto-runs. The agent
> also appends a `.intentflow/timeline.md` entry. Remaining: use `port`/`url`/
> `ready_when` for the Open-URL + ready detection; end-to-end GUI test on a real
> Docker project.

## Problem
`Run` only handles projects it can auto-detect or that ship a committed
`.evoride/run.json`. Real projects (Docker, monorepos, custom toolchains) don't
fit the heuristic — e.g. `docker compose up` based stacks currently don't work.
We don't want to commit machine-specific run config into the repo either.

## Approach
When run isn't configured (or the user picks **"Set up run with AI"**), EvorIDE
hands the project to a Claude agent with a precise instruction to investigate how
to run it and **write a run config** that EvorIDE then uses.

### Storage (per-machine, outside the repo)
`~/.evoride/{project_id}/runinfo.json` — keyed by the store's project UUID, so it
never pollutes the repo and can differ per machine (Docker here, local there).

**Run read precedence:** `~/.evoride/{project_id}/runinfo.json` → repo
`.evoride/run.json` → built-in auto-detect.

### Schema (`runinfo.json`)
```json
{
  "generated_by": "claude-opus-4-8",
  "generated_at": "2026-06-08T07:00:00Z",
  "services": [
    {
      "name": "web",
      "command": "docker compose up web",
      "cwd": "",
      "port": 3000,
      "url": "http://localhost:3000",
      "ready_when": "ready in|Local:.*3000"
    }
  ],
  "notes": "Requires Docker Desktop running."
}
```
(`port`/`url`/`ready_when` are new optional fields beyond today's `{name,command,cwd}`.)

### The instruction EvorIDE injects into the agent
> Analyze this project and produce a run configuration EvorIDE will use to start
> it for local development. Inspect `package.json` scripts, `Cargo.toml`,
> `Dockerfile` / `docker-compose.yml`, `Makefile`, `Procfile`, etc. Prefer Docker
> if a compose file defines the dev stack. Verify the tools exist (`which docker`,
> …). Write JSON to `~/.evoride/{project_id}/runinfo.json` matching the schema
> below — for each service give the exact start command, cwd relative to the
> project root, the port/URL it serves (if any), and an optional regex that
> matches a "ready" line in its output. Then summarize what you configured.

### Docker specifically
The generated command (e.g. `docker compose up`) runs in a pty with the
login-shell PATH (fixed at startup), so `docker` resolves. `port`/`url` drive the
"Open URL" button; `ready_when` lets EvorIDE mark a service ready.

## Tasks
- **Backend** (`run.rs`/`lib.rs`): add `runinfo_path(project_id)`; read+merge with
  precedence; extend `Service` with `port`/`url`/`ready_when`; command
  `generate_run_config(project_id)` that spawns the agent pre-loaded with the
  instruction; command to read/save `runinfo.json`.
- **Frontend** (`RunControl`): "Set up run with AI" when unconfigured/failing →
  spawns the agent → reloads run config on completion → shows `notes`.
- **IntentFlow tracking:** when a run config is generated, append a `timeline.md`
  entry (attributed to the person + agent/model) so the plan auto-tracks it.

## Acceptance
- A Docker-compose project: "Set up run with AI" → agent writes `runinfo.json` →
  Run starts `docker compose up` → Open-URL works. No repo files changed.
