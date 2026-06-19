# Contributing to Evor

Thanks for being here 🙌 — this project exists to be built *with* people. It's early and
moves fast, so contributions of every size are welcome: bug reports, docs, a new agent
integration, or picking up a roadmap item.

## Ground rules

- **Be kind and pragmatic.** It's alpha software; assume good intent.
- **Keep PRs focused.** One feature/fix per PR is much easier to review.
- **Discuss big changes first.** Open an issue before a large refactor or new subsystem so
  we don't duplicate work or pull in different directions.

## Project layout

| Path | What |
|---|---|
| `ide/` | Evor desktop app — `src/` (React/TS), `src-tauri/src/` (Rust backend) |
| `tui/` | eterm smart terminal (Rust, ratatui) |
| `server/` | WebSocket relay (Rust, Axum) |
| `web/` | Web dashboard (Next.js) |
| `core/` | `eterm-core` — shared terminal/agent/error detection (Rust) |
| `shared/` | Wire protocol (Rust) |

The Rust crates `core`, `shared`, `tui`, `server` are a Cargo workspace; `ide/src-tauri` is
a separate Cargo project that depends on `core` by path.

## Dev setup

Prereqs: **Rust** (stable), **Node 20+**, **pnpm**, and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
# IDE
cd ide && pnpm install && pnpm tauri dev

# Rust workspace (terminal / relay / core)
cargo run -p eterm           # the TUI
cargo run -p eterm-server    # the relay
cargo test -p eterm-core     # detection tests
```

## Before you open a PR

Run the relevant checks — both should be clean:

```bash
# Backend (from ide/src-tauri or repo root for the workspace)
cargo check
cargo test -p eterm-core

# IDE frontend (runs tsc + vite)
cd ide && pnpm build
```

- No unused imports/vars (the frontend uses strict TS).
- Match the surrounding style. New UI uses the theme CSS variables in
  `ide/src/App.css` (`--bg --surface --border --fg --brand …`) — **no hardcoded colors**.
- New Rust commands go in `ide/src-tauri/src/lib.rs` and must be added to the
  `tauri::generate_handler!` list; add a matching wrapper in `ide/src/lib/tauri.ts`.

## Good first contributions

- **Add an agent CLI.** Add an entry to `ide/src/lib/clis.ts` for your tool
  (`aider`, `gemini`, `qwen-code`, …) and a resume mapping in
  `ide/src-tauri/src/lib.rs` (`resume_command`). Tell us how it went in the PR.
- **Improve detection.** Error / input-prompt / agent signatures are heuristic and live in
  `core/src/lib.rs` and `tui/src/detector.rs`. Real-world cases that aren't caught (or are
  false-positives) make great, well-scoped PRs — add a test alongside.
- **Roadmap items.** See the [README roadmap](README.md#roadmap). Comment on the issue first.
- **Docs & onboarding.** If something tripped you up getting started, fixing the README is a
  real contribution.

## Reporting bugs / requesting features

Use the issue templates. For bugs, include your OS, what you did, what you expected, and what
happened (logs/screenshots help a lot — this is a GUI app).

## Commit messages

Conventional-ish is appreciated but not required — a clear, imperative subject is enough
(e.g. `Add aider to the agent launcher`).

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).
