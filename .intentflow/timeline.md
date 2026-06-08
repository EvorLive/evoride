# Timeline

Dated decisions and milestones (newest first).

## 2026-06-08
- Shipped **AI run setup v1** — `RunControl` "✨ Set up run" spawns an agent that
  writes `~/.evoride/{project_id}/runinfo.json`; EvorIDE reads it with precedence
  over the repo config, then auto-runs. Backend unit-tested. *(Rabin · Claude Opus 4.8)*
- Started the committed EvorIDE plan (`.intentflow/`). Captured the backlog in
  [roadmap.md](roadmap.md) and spec'd **AI run setup** —
  [plans/ai-run-config.md](plans/ai-run-config.md): generate a per-project run
  config via an agent into `~/.evoride/{project_id}/runinfo.json` to fix Docker /
  monorepo / custom run. *(Rabin · planning w/ Claude Opus 4.8)*
- Shipped v0.1.4: EvorIDE branding + icon, all-platform installers, code-signing
  docs. Launch assets ready (README + Pages screenshot, social card). Show HN
  drafted, deferred.
