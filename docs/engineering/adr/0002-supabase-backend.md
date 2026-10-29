# 0002 — Supabase as the backend

| Status | Accepted. The Edge Functions part is superseded by [ADR 0008](0008-vps-bun-hono-api.md) (API server on Bun + Hono on a VPS); Postgres, Storage and Realtime by [ADR 0012](0012-own-postgres-files-realtime.md). Supabase keeps Auth. |
|---|---|
| Date | 2026-10-26 |
| Related | [Architecture](../architecture.md) · [Data model](../data-model.md) · [Security & privacy](../security-privacy.md) |

## Context

Studify needs:
- accounts (email + Google)
- a relational database for the knowledge map, cards, plans and grades
- file storage for PDFs, page images, photos and audio
- realtime channels for live battles, duels and job progress
- a place to run short server code that holds the Claude API key

The data is relational and per-user/per-Turma access control is central, and most users are minors (see [security-privacy.md](../security-privacy.md)). The team is small and wants managed infrastructure. Data residency in Brazil is preferred.

## Decision

Use **Supabase**:
- **Postgres** as the source of truth, with **Row Level Security on every table**. Plain CRUD from the app goes through PostgREST under RLS, with no custom API layer.
- **Supabase Auth** for magic link/OTP and Google sign-in.
- **Storage** with private buckets and RLS-based policies.
- **Realtime** for battles, duels, presence and `ai_jobs` progress.
- **Edge Functions** (Deno, TypeScript) for short synchronous server work: tutor chat streaming, single-answer grading, budget checks, sync push, invite join.
- Project region **São Paulo (`sa-east-1`)**.
- Schema and policies as SQL migrations in `supabase/migrations`, tested with pgTAP.

## Alternatives considered

| Option | Why not |
|---|---|
| **Firebase (Firestore + Cloud Functions)** | Document model is a poor fit for the relational knowledge map and analytics (mastery, insights). Security rules are harder to test than SQL RLS. Vendor-specific query model. |
| **Custom Node API + managed Postgres (e.g. Neon/RDS) + S3 + Auth0** | More pieces to build and operate (auth, file access control, realtime). Slower to reach Phase 1. |
| **PocketBase / self-hosted** | Operational burden and backups are on the team. Fewer managed guarantees. |
| **Appwrite** | Viable, but a smaller ecosystem and less familiar Postgres tooling (RLS, pgTAP, pg-boss on the same database). |

## Consequences

- **+** Auth, database, storage, realtime and functions in one place. Local development via `supabase start`.
- **+** RLS gives defense in depth even if an Edge Function has a bug. Policies are testable SQL.
- **+** Future calendar triggers share the same Postgres ([ADR 0010](0010-direct-sse-api.md)); immediate operations run directly.
- **−** Edge Functions have hard limits (verified 2026-10-26 in [Supabase docs](https://supabase.com/docs/guides/functions/limits): 150 s wall clock on Free / 400 s on paid, 2 s CPU per request, 256 MB memory, 150 s request idle timeout). Long or bulk AI work therefore goes to a separate worker.
- **−** RLS mistakes are the main privacy risk. Mitigated by the RLS coverage gate and pgTAP suite ([testing-strategy.md §4](../testing-strategy.md#4-database-and-rls-tests)).
- **−** Vendor coupling to Supabase Auth and Storage APIs. Postgres itself stays portable.
