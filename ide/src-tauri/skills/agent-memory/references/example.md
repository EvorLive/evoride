# Worked Example

A realistic example of `.ai/` for a job application tracking platform after 3 sessions.

---

## `.ai/current.md` (after 3 sessions, one conflict resolved)

```markdown
# Project Knowledge — Current State
Last reconciled: 2025-06-10 | Sessions included: 001, 002, 003

---

## Project Overview
Job application tracking platform with AI resume-job matching.
Users upload resumes, which are embedded and matched against job listings.

Tech stack:
- frontend: Next.js 14 (app router)
- backend: Go 1.22
- database: PostgreSQL 15 + pgvector extension
- auth: JWT (sessions-based as of Day 2 refactor — see note)

---

## Architecture

### Key Entry Points
- API: `backend/cmd/api/main.go`
- Frontend: `frontend/src/app/layout.tsx`

### Main Flows
- Resume Upload: `POST /resumes` → `backend/resumes/handler.go` → `embeddings.Service` → pgvector insert
- Job Matching: `GET /matches/:resumeID` → `matching/service.go` → vector cosine search → scored results
- Auth: `POST /auth/login` → `auth/handler.go` → `auth/session.go` → session cookie set

### Key Files
| File | Purpose | Notes |
|------|---------|-------|
| `backend/matching/service.go` | Core matching logic | Entry point for all scoring |
| `backend/embeddings/service.go` | Generates embeddings | Calls OpenAI ada-002 |
| `backend/auth/session.go` | Auth logic | **Was JWT, refactored to sessions Day 2** |
| `frontend/src/app/jobs/page.tsx` | Job listing UI | Fetches from `/api/jobs` |
| `migrations/` | DB schema | 12 migrations, latest adds pgvector index |

---

## Decisions & Why
- pgvector over Pinecone: cost reduction, fewer moving parts — found in `docs/ADR-003.md`
- Sessions over JWT: JWT caused issues with token revocation — refactored in Session 002
- Go over Node for backend: team preference + performance — mentioned in `README.md`

---

## Known Gotchas
- `embeddings.Service` is not thread-safe — do not call concurrently (comment in `embeddings/service.go:34`)
- pgvector index must be rebuilt after bulk inserts (`migrations/012_rebuild_index.sql`)
- Frontend uses `.env.local` for API URL — not `.env`

---

## Open Questions
- [ ] How does rate limiting work? Not found yet.
- [ ] Deployment setup — no Dockerfile or CI config found.
- [x] ~~How does auth work?~~ — RESOLVED Session 002

---

## Confidence Index
- [CONFIRMED x2] matching logic lives in `backend/matching/service.go`
- [CONFIRMED x3] pgvector used for embeddings storage
- [CONFIRMED x2] OpenAI ada-002 used for embedding generation
```

---

## `.ai/changelog.md` (append-only, 3 sessions)

```markdown
# Agent Knowledge Changelog
Append-only. Do not edit past entries.

---

## 2025-06-08 | Session 001 | Explore codebase structure + auth
- DISCOVERED: Go backend, Next.js frontend confirmed
- DISCOVERED: pgvector in use → `migrations/010_add_pgvector.sql`
- DISCOVERED: matching entry point → `backend/matching/service.go`
- DISCOVERED: auth uses JWT → `backend/auth/middleware.go`
- DISCOVERED: embeddings use OpenAI ada-002 → `backend/embeddings/service.go:18`
- OPEN: rate limiting — not found
- OPEN: deployment setup — no Dockerfile seen

## 2025-06-09 | Session 002 | Refactor auth to sessions
- CHANGED: auth mechanism JWT → sessions (token revocation issues)
- DISCOVERED: new auth file → `backend/auth/session.go`
- SUPERSEDED: `backend/auth/middleware.go` JWT logic no longer primary auth path
- CONFIRMED: matching entry point → `backend/matching/service.go`
- OPEN: deployment still not explored

## 2025-06-10 | Session 003 | Investigate embeddings pipeline
- CONFIRMED: OpenAI ada-002 for embeddings
- CONFIRMED: pgvector stores embeddings
- DISCOVERED: embeddings.Service not thread-safe → `embeddings/service.go:34`
- DISCOVERED: pgvector index rebuild needed after bulk insert → `migrations/012`
- OPEN: rate limiting still not found
- OPEN: deployment still not found

## 2025-06-10 | RECONCILIATION | Merged sessions 001 and 002
- RESOLVED: auth mechanism — chose Session 002 (more recent, was explicit refactor)
- current.md updated to reflect sessions auth
```

---

## What Agent 4 Sees When Starting

Agent 4 reads `current.md` and immediately knows:
- The full tech stack
- Exactly where matching, auth, and embeddings live
- That JWT was refactored to sessions (and why)
- Two specific gotchas that would have taken time to find
- Exactly what hasn't been explored yet (rate limiting, deployment)

Instead of spending 30 minutes re-exploring, Agent 4 goes straight to: **"I'll look into rate limiting and deployment."**
