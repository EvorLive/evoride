# Templates

Copy-paste these when initializing or updating `.ai/` files.

---

## `current.md` Template

```markdown
# Project Knowledge — Current State
Last reconciled: [date] | Sessions included: [list]

---

## Project Overview
[1-3 sentences: what this project does]

Tech stack:
- [language/framework]: [version/notes]
- [database]: [notes]
- [other key tech]: [notes]

---

## Architecture

### Key Entry Points
- [entry point]: [file path] — [what it does]

### Main Flows
<!-- Format: Flow name → step → step → step → output -->
- [Flow name]: [step] → [step] → [step]

### Key Files
<!-- Only list files that are non-obvious or central -->
| File | Purpose | Notes |
|------|---------|-------|
| [path] | [what it does] | [gotchas, last verified] |

---

## Decisions & Why
<!-- Architecture/tech decisions discovered in the codebase -->
- [decision]: [reason] — [source: ADR / comment / code pattern]

---

## Known Gotchas
<!-- Things that would trip up a new agent -->
- [gotcha]: [where / why]

---

## Open Questions
<!-- Things not yet explored or understood -->
- [ ] [question] — [who was exploring this, if known]

---

## Confidence Index
<!-- Facts confirmed by multiple sessions -->
- [CONFIRMED x2] [fact]
- [CONFIRMED x3] [fact]
- [UNRESOLVED] [conflicting fact — needs human review]
```

---

## `changelog.md` Template

```markdown
# Agent Knowledge Changelog
Append-only. Do not edit past entries.

---

## [YYYY-MM-DD] | Session 001 | [brief task description]
- DISCOVERED: [fact] → [location/evidence]
- DISCOVERED: [fact] → [location/evidence]
- OPEN: [question not answered this session]

```

---

## `sessions/session-NNN.md` Template

```markdown
# Session [NNN] — [YYYY-MM-DD] — [brief task title]

**Task:** [what was asked / goal of this session]
**Duration:** [approximate]

---

## What I Explored
- `[file/module]`: [what I found, key observations]
- `[file/module]`: [what I found, key observations]

## Key Facts Discovered
- [concrete fact]: found in `[path]` [line/function if relevant]
- [concrete fact]: found in `[path]`

## Changes Made
- `[file]`: [what changed and why]

## Conflicts With Existing Knowledge
<!-- Did anything contradict current.md? -->
- [topic]: current.md said [X], actually it's [Y] — updated current.md

## What I Didn't Get To
- [area/question]

## Recommended Next Steps
1. [specific action for next agent]
2. [specific action for next agent]
```

---

## Changelog Entry Prefixes (use consistently)

| Prefix | Meaning |
|--------|---------|
| `DISCOVERED` | New fact learned for the first time |
| `CONFIRMED` | Existing fact verified again |
| `CHANGED` | Fact updated — old version was wrong/outdated |
| `SUPERSEDED` | Old fact explicitly replaced by newer understanding |
| `OPEN` | Question raised, not yet answered |
| `RESOLVED` | Previously open question now answered |
| `UNRESOLVED` | Conflict between agents, needs human review |
