<!-- Thanks for contributing! Keep PRs focused — one feature/fix per PR. -->

## What & why
<!-- What does this change, and what problem does it solve? Link any issue: Closes #123 -->

## Component(s)
- [ ] EvorIDE (`ide/`)
- [ ] eterm TUI (`tui/`)
- [ ] relay (`server/`)
- [ ] web dashboard (`web/`)
- [ ] core / shared

## Checklist
- [ ] Backend builds: `cargo check` (and `cargo test -p eterm-core` if detection changed)
- [ ] Frontend builds: `cd ide && pnpm build`
- [ ] No hardcoded colors in new UI (uses theme CSS vars)
- [ ] New Rust commands registered in `generate_handler!` + wrapped in `tauri.ts`
- [ ] Focused change; big/architectural changes were discussed in an issue first

## Notes for reviewers
<!-- Screenshots for UI changes are super helpful. Anything tricky to call out? -->
