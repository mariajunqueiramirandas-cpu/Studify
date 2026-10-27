# Studify — Documentation

Studify turns class PDFs into a complete study system (notes, flashcards, quizzes, tutor, plan) for **school exam weeks** and **ENEM**. Android app, PT-BR interface, built for a group of classmates.

## Start here

| Document | What it covers |
|---|---|
| [Product requirements (PRD)](product/PRD.md) | Vision, principles, users, modes, **full feature catalog with IDs**, non-goals, glossary |
| [Roadmap](product/roadmap.md) | Phases 0–5, scope and exit criteria |
| [User flows](product/user-flows.md) | End-to-end journeys (onboarding, upload, exam week, daily session, Turma) |
| [Open decisions](product/open-decisions.md) | Every decision waiting on the owner, with the default used until decided |

## Feature specifications

| Spec | Features |
|---|---|
| [00 — Platform: shell, accounts, subjects, limits, notifications, offline](specs/00-platform.md) | PLT-01…07 |
| [01 — Ingestion & knowledge map](specs/01-ingestion-knowledge-map.md) | ING-01…08, TRU-01 |
| [02 — Learn: notes, glossary, concept map](specs/02-learn-notes.md) | LRN-01…05 |
| [03 — Tutor](specs/03-tutor.md) | TUT-01…06 |
| [04 — Flashcards & memory](specs/04-flashcards-memory.md) | MEM-01…06 |
| [05 — Practice & exams](specs/05-practice-exams.md) | PRA-01…08 |
| [06 — Feed de Estudos](specs/06-feed-de-estudos.md) | FED-01 |
| [07 — Goals & Semana de Provas](specs/07-goals-semana-de-provas.md) | GOL-01…12 |
| [08 — Prova Provável](specs/08-prova-provavel.md) | PRA-09, ENM-08 |
| [09 — ENEM mode](specs/09-enem-mode.md) | ENM-01…10 |
| [10 — Turma & social](specs/10-turma-social.md) | SOC-01…09, TRU-02 |
| [11 — Câmera Mágica](specs/11-camera-magica.md) | CAM-01…03 |
| [12 — Interactive learning](specs/12-interactive-learning.md) | INT-01…03 |
| [13 — Motivation & wellbeing](specs/13-motivation-wellbeing.md) | MOT-01…04, WEL-01…04 |

## Engineering

| Document | What it covers |
|---|---|
| [Architecture](engineering/architecture.md) | System overview, stack, **canonical domain model**, conventions, NFRs |
| [Data model](engineering/data-model.md) | Postgres schema, RLS policies, local SQLite schema |
| [API](engineering/api.md) | Edge Functions, worker jobs, Realtime channels |
| [AI pipeline](engineering/ai-pipeline.md) | Claude usage: models, prompts, structured outputs, citations, caching, batch, budgets |
| [Learning engine](engineering/learning-engine.md) | FSRS, mastery, planner, readiness/predicted grade, calibration, TRI estimate |
| [Mobile app](engineering/mobile-app.md) | Expo app structure, navigation, offline sync, notifications, widgets, builds |
| [Security & privacy](engineering/security-privacy.md) | Auth, RLS, secrets, LGPD and minors, content safety |
| [Testing strategy](engineering/testing-strategy.md) | Unit, integration, RLS, AI evals, E2E on Android |
| [ADRs](engineering/adr/) | Architecture decision records |

## Design

| Document | What it covers |
|---|---|
| [UX guidelines](design/ux-guidelines.md) | Navigation map, screen inventory, interaction patterns, accessibility |
| [PT-BR copy guide](design/copy-pt-br.md) | Voice and tone, terminology, key UI strings |

---

## Conventions for these docs

- **Language:** docs are in English; UI strings and feature names are in PT-BR exactly as they appear in the app.
- **Feature IDs** (e.g. `MEM-02`) come from the [PRD catalog](product/PRD.md#5-feature-catalog) and are the single source of truth for scope and phase.
- **Entity names** (e.g. `card_states`) come from the [architecture domain model](engineering/architecture.md#3-domain-model).
- **Requirement IDs** inside a spec extend the feature ID: `MEM-02.3` is requirement 3 of feature MEM-02.
- Every spec follows the same template:

```markdown
# NN — Title
| Status | Phase(s) | Features |
## 1. Summary
## 2. Goals and non-goals
## 3. User stories
## 4. Functional requirements      (numbered: FEAT-NN.n)
## 5. UX and screens               (key PT-BR strings)
## 6. Data                         (entities used/added; detail in data-model.md)
## 7. AI behavior                  (task, inputs, output schema, citations, caching, effort)
## 8. Rules and algorithms         (or link to learning-engine.md)
## 9. Edge cases and errors
## 10. Metrics
## 11. Acceptance criteria         (testable checklist)
## 12. Open questions
```
