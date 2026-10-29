# Architecture Decision Records

Each ADR records one significant decision: its context, the decision, the alternatives considered and the consequences. ADRs are **immutable once accepted**. A later change gets a new ADR that supersedes the old one, and the old one's status is updated to point to it.

| # | Title | Status | Date |
|---|---|---|---|
| [0001](0001-expo-react-native-android-first.md) | Expo / React Native, Android first | Accepted | 2026-10-26 |
| [0002](0002-supabase-backend.md) | Supabase as the backend | Accepted | 2026-10-26 |
| [0003](0003-claude-api-opus-default.md) | Claude API as the only LLM, Haiku 5.5 by default (Opus 5.5 before 2026-10-27) | Accepted, amended 2026-10-27 | 2026-10-26 |
| [0004](0004-fsrs-on-device.md) | FSRS scheduling on device with `ts-fsrs` | Accepted | 2026-10-26 |
| [0005](0005-job-worker-pg-boss.md) | Node.js job worker with pg-boss (hosting open) | Superseded by 0010 | 2026-10-26 |
| [0006](0006-retrieval-without-embeddings.md) | Retrieval without embeddings (knowledge-map routing + Postgres FTS) | Accepted | 2026-10-26 |
| [0007](0007-offline-first-append-only-reviews.md) | Offline-first with append-only review logs | Accepted | 2026-10-26 |
| [0008](0008-vps-bun-hono-api.md) | API server on a VPS with Bun and Hono (Supabase Edge Functions retired) | Accepted | 2026-10-27 |
| [0009](0009-no-request-waits-on-claude.md) | No request waits on Claude: AI work runs as a job or inside a stream | Superseded by 0010 | 2026-10-28 |
| [0010](0010-direct-sse-api.md) | Direct SSE operations in one API service | Accepted | 2026-10-28 |
| [0011](0011-write-ahead-and-background-work.md) | Write content ahead (the Trilha, once per subject), keep side work in the background | Accepted | 2026-10-29 |

## Template

```markdown
# NNNN — Title

| Status | Proposed / Accepted / Superseded by NNNN |
|---|---|
| Date | YYYY-MM-DD |
| Related | links |

## Context
## Decision
## Alternatives considered
## Consequences
```
