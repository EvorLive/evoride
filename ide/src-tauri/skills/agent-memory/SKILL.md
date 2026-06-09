---
name: agent-memory
description: >
  Manages persistent knowledge and context handoff between Claude Code sessions and parallel agents.
  Use this skill whenever: starting a new Claude Code session on an existing project, picking up where
  a previous agent left off, running multiple agents in parallel on the same codebase, needing to
  transfer context from one session to another, or wanting to avoid re-exploring code already understood.
  Trigger when the user says things like "continue from last session", "another agent already explored this",
  "share context between agents", "agent handoff", "don't repeat work", or "what did the last session learn".
  Also trigger proactively at the END of any long Claude Code session to save context for next time.
---

# Agent Memory Skill

Manages a persistent `.ai/` knowledge layer in the project so that any agent — starting fresh or
running in parallel — begins from accumulated understanding rather than from zero.

## The Core Problem

Without this skill, every new agent session:
1. Re-reads files already understood
2. Re-traces flows already mapped
3. Burns tokens rediscovering what a previous agent learned
4. Has no awareness of parallel agents' findings

## The `.ai/` Folder Structure

This skill creates and maintains the following in the project root:

```
.ai/
├── current.md          ← The single source of truth (what's true RIGHT NOW)
├── changelog.md        ← Append-only log (never edited, only appended to)
└── sessions/
    ├── session-001.md  ← Full notes from each individual session
    ├── session-002.md
    └── ...
```

See `references/templates.md` for exact file formats.

---

## Workflows

### Workflow A: Starting a New Session (Reading Context)

When beginning work, do this BEFORE anything else:

1. **Check if `.ai/` exists**
   ```bash
   ls .ai/ 2>/dev/null && echo "EXISTS" || echo "FIRST SESSION"
   ```

2. **If it exists — load context:**
   ```bash
   cat .ai/current.md
   ```
   Read this fully. This is your starting map. Do not re-explore things already documented here
   unless the task requires verifying or updating them.

3. **Check for recent changelog entries** (last 2-3 sessions worth):
   Read the bottom of `.ai/changelog.md` to catch anything added after `current.md` was last reconciled.

4. **Announce what you already know** to the user before starting work:
   > "I can see from previous sessions that: [summary]. I'll pick up from [open questions / next steps]."

---

### Workflow B: Ending a Session (Writing Context)

At the end of any session (or when asked to save context), do ALL of the following:

#### Step 1 — Write a session file
Create `.ai/sessions/session-NNN.md` (increment from last number):

```markdown
# Session NNN — [date] — [brief title]

## What I explored
- [file/system]: [what I found]
- ...

## Key facts discovered
- [fact]: [location/evidence]
- ...

## Changes made
- [what changed, where, why]
- ...

## Conflicts found
- [if any existing facts in current.md were wrong or outdated, note here]

## Open questions / not yet explored
- [thing I didn't get to]
- ...

## Recommended next steps
- [what a future agent should do next]
```

#### Step 2 — Append to changelog
Add to the BOTTOM of `.ai/changelog.md` (never edit existing entries):

```markdown
## [date] | Session NNN | [agent/task description]
- DISCOVERED: [fact] → [location]
- CHANGED: [old fact] → [new fact] (reason: [why])
- SUPERSEDED: [old fact from session X is no longer true]
- OPEN: [question not yet answered]
```

Use these prefixes consistently: `DISCOVERED`, `CHANGED`, `SUPERSEDED`, `OPEN`, `CONFIRMED`.

#### Step 3 — Reconcile current.md
Update `.ai/current.md` to reflect what is true NOW:
- For anything CHANGED or SUPERSEDED: update the entry, note the session that changed it
- For new DISCOVERED facts: add them in the relevant section
- Mark any facts as `[CONFIRMED by N sessions]` if multiple sessions agree
- Do NOT keep outdated facts — this file is the present truth, not history

---

### Workflow C: Parallel Agent Reconciliation

When two or more agents have been working simultaneously and a new agent (or human) needs
a unified view:

1. **Read all recent session files** that haven't been reconciled into `current.md` yet:
   ```bash
   ls -lt .ai/sessions/
   ```

2. **Identify conflicts** — look for the same topic addressed differently across sessions:
   - Same file described differently
   - Same flow with different steps
   - Contradictory facts about architecture or decisions

3. **Resolve each conflict using this priority order:**
   - Most recent timestamp wins for factual/code discoveries
   - If both are recent, prefer the session with more evidence (file paths, line numbers)
   - If truly ambiguous, flag as `[UNRESOLVED — needs human review]` in `current.md`

4. **Write a reconciliation entry in changelog:**
   ```markdown
   ## [date] | RECONCILIATION | Merged sessions NNN and NNN
   - RESOLVED: [topic] — chose session NNN version because [reason]
   - UNRESOLVED: [topic] — needs human review
   ```

5. **Update `current.md`** with the reconciled view.

---

### Workflow D: First Session Setup

If `.ai/` doesn't exist yet, initialize it:

```bash
mkdir -p .ai/sessions
```

Then create `.ai/current.md` from the template in `references/templates.md`.
Create an empty `.ai/changelog.md` with just the header.
Add `.ai/` to `.gitignore` OR commit it — see note below.

**Should `.ai/` be in git?**
- **Commit it** if the team wants shared knowledge across all developers and CI agents
- **Gitignore it** if knowledge is personal/session-specific or you don't want it in history

---

## Key Rules

1. **`changelog.md` is append-only.** Never edit past entries. This is your audit trail.
2. **`current.md` is always present-tense.** No historical info — that lives in sessions/ and changelog.
3. **Be specific.** Vague facts like "auth is complex" are useless. Good facts include file paths, function names, line numbers where relevant.
4. **Confidence signals matter.** A fact confirmed by 3 sessions is more reliable than one seen once. Mark it.
5. **Don't over-document.** Only record things that would save a future agent meaningful time. Skip obvious things.

---

## Reference Files

- `references/templates.md` — Copy-paste templates for all three file types
- `references/example.md` — A realistic worked example of a populated `.ai/` folder

Read these when you need the exact format or want to see a real example.
