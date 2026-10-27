# Studify

**Envie o material da aula. Receba um sistema de estudos completo.**

Studify turns class PDFs (teacher slides, apostilas, notes, past tests) into everything a student needs to study — notes, flashcards with spaced repetition, quizzes and mock exams, an AI tutor that cites the page — and plans each day up to the exam. It supports two modes:

- **Semana de Provas** — a school exam week with many subjects, each with its own test date and content list.
- **ENEM** — the four areas + Redação, TRI-aware simulados and essay correction (later phase).

Android app (Expo / React Native), interface in Portuguese (Brazil), built for a group of classmates studying together.

## Status

All roadmap phases (0–5) are implemented in code and covered by automated tests; the exit criteria still have to be verified on a real Android phone with real class material. See the [roadmap](docs/product/roadmap.md#implementation-status).

## Repository

| Path | What |
|---|---|
| `apps/mobile` | Expo / React Native app (Expo Router, SQLite + Drizzle with offline sync, TanStack Query, zustand); local Android module `modules/studify-focus` for Modo foco |
| `apps/api` | Bun + Hono API server (`/api/<name>`), deployed on the VPS |
| `apps/worker` | pg-boss jobs: ingestion, content generation, planning, grading, notifications, Phase 4–5 jobs |
| `packages/shared` | Domain logic shared by app, API and worker (FSRS, planner, TRI, grading, motivation, wellbeing) and the API/sync schemas |
| `packages/prompts` | Prompt tasks, output schemas and fixtures |
| `packages/ai`, `packages/speech` | Claude client with budgets; TTS providers |
| `supabase` | Migrations, RLS and pgTAP tests |

Common commands (from the root): `pnpm typecheck`, `pnpm test`, `pnpm db:test` (pgTAP against a local Postgres), `pnpm db:rls-coverage`, `pnpm api:dev`. The app: `pnpm --filter @studify/mobile start` (needs a development build for the native modules).

## Documentation

All product, feature and engineering documents live in [`docs/`](docs/README.md):

- [Product requirements (PRD)](docs/product/PRD.md) — vision, users, full feature catalog with IDs
- [Roadmap](docs/product/roadmap.md) — phases and exit criteria
- [Open decisions](docs/product/open-decisions.md) — choices waiting on the owner, with defaults
- [Feature specs](docs/specs/) — one per feature area
- [Architecture](docs/engineering/architecture.md) — system design and domain model
