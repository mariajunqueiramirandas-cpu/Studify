# 14 — Trilha (guided path)

| Status | Phase(s) | Features |
|---|---|---|
| Draft v1 | 5 | TRL-01 |

Related: [PRD](../product/PRD.md#515-trilha-trl) · [01 — Ingestion & knowledge map](01-ingestion-knowledge-map.md) (the outline, prerequisites) · [05 — Practice & exams](05-practice-exams.md) (question rules) · [06 — Feed de Estudos](06-feed-de-estudos.md) (micro-lessons) · [13 — Motivation](13-motivation-wellbeing.md) (skill tree, Chefão) · [learning-engine.md](../engineering/learning-engine.md#23-trilha-trl-01)

---

## 1. Summary

A Duolingo-style path through one subject. The app decides the order in which the whole course should be learned, then teaches it one concept at a time: a short explanation, questions right after it, feedback that teaches, a different explanation when the student misses, and a chapter test at the end of each topic that must be passed to move on. Key terms are underlined and explained on tap. The path is persistent: the student can leave at any step and resume exactly there. Content is written on demand, one concept ahead, not all at once.

## 2. Goals and non-goals

**Goals**
- One obvious thing to do in a subject: "Continuar a trilha".
- Order matters: fundamentals before what depends on them, across the whole subject.
- Retrieval right after teaching, and re-teaching on mistakes, so a chapter is marked done only when it was understood.
- Pay only for what the student reaches: generate a concept when it is about to be needed, with a small buffer so the student rarely waits.

**Non-goals (v1)**
- Offline. The Trilha needs a connection; everything already generated stays on the server and the student resumes where they left off.
- Hearts, lives, or streak pressure inside the path (spec 13 healthy-use rules apply).
- Replacing Hoje, the Feed or the skill tree. The Trilha lives alongside them and is the first entry on the subject home.
- A Trilha per goal or exam (crossing subjects). One per student and subject.

## 3. User stories

| # | As a… | I want… | So that… |
|---|---|---|---|
| U1 | student starting a subject | the app to tell me what to learn first and next | I don't have to plan |
| U2 | student | a short explanation and then questions about it | I learn and check right away |
| U3 | student who got it wrong | to understand why and see it explained another way | I don't move on confused |
| U4 | student | a test at the end of each chapter | I know I really understood it |
| U5 | student | to tap a key word and see what it means | I don't get stuck on vocabulary |
| U6 | student on the bus | to stop at any moment and continue later from the same step | short sessions count |

## 4. Functional requirements

- **TRL-01.1** Entry: a Trilha card is the first block of the subject home (S-MAT-03), above the shortcuts: "Começar a trilha" before the first open, then "Continuar a trilha · Capítulo i de n", and "Trilha concluída ✓" at the end. The card reads the student's own `trails` row (no trail is created until they open it).
- **TRL-01.2** Path: on first open, `trail.plan` reads the subject outline (units, topics, objectives, concepts) and the prerequisites and returns the chapter order (one chapter per topic) and the concept order inside each, with a "por que agora" per chapter and a one-line goal. The server repairs the proposal (§8.1). If the call fails, the outline order is used. Excluded topics ("não cai na prova"), placeholders and topics without pages are left out.
- **TRL-01.3** Outline changes: when the outline the plan was built from changed (new material, outline edits, exclusions), the next open keeps the finished chapters and the one in progress in place (with their concept lists refreshed) and plans the rest again.
- **TRL-01.4** Lesson: each concept starts with a lesson — a title and 60–160 words of Markdown with the central idea first, 2–4 bullet points, a concrete example, formulas in LaTeX and page chips (📄). "Entendi, bora praticar" moves on.
- **TRL-01.5** Questions: multiple choice, 4 options, select then "Verificar". Feedback in place: right/wrong, why the chosen option is wrong, why the right one is right, the explanation, an optional tip, 📄. A concept is cleared after **2 correct answers**. Answers are mastery evidence (source `trail`, weight 1.0).
- **TRL-01.6** Re-teaching: after a wrong answer the next step is a new explanation from another angle, aimed at the confusion the chosen option reveals, followed by a fresh question on the same point. After **5 answers** without clearing, the concept is marked "pra revisar" and the path moves on (the chapter test still gates).
- **TRL-01.7** Chapter test: once every concept of the chapter is cleared or "pra revisar", a test of 2 questions per concept (4–10), weighted toward the weak concepts, mixed. Pass at **70%** (the Chefão bar). A failed round re-teaches up to 3 missed concepts (explanation + question each), then runs a new round with new questions. Passing finishes the chapter; the last chapter finishes the Trilha.
- **TRL-01.8** On-demand generation: content is generated one concept at a time (a lesson with 3 questions — 2 asked, 1 spare), the re-teaching when a miss happens, the chapter test when the last concept starts. The buffer keeps one step of lookahead: the next concept's lesson, the chapter test while on the last concept, the next chapter's first lesson during the test. The app prefetches in the background; it shows "Preparando o próximo passo…" only when the step it needs isn't ready.
- **TRL-01.9** Key terms: each lesson and question carries up to 6 key terms with one-sentence definitions; the first occurrence is underlined (dotted, ux §7.3) and opens a sheet with the definition.
- **TRL-01.10** Resume: the step on screen is stored as served; leaving and opening again shows the same step. Answering a step twice never grades it twice.
- **TRL-01.11** Path view: "Ver a trilha" lists the chapters (done, now, later) with their "por que agora", and the concepts of the current chapter with their state.

## 5. UX and screens

- **S-TRL-01 Trilha** (immersive, from the subject home): header with the whole-path progress bar and "Capítulo i de n · {tópico}"; action "Ver a trilha" (map icon). Body: one step. Footer: one primary button ("Entendi, bora praticar" · "Verificar" · "Continuar").
- Milestones between steps: chapter done (Capi celebrating, "Próximo: {capítulo}"), failed test ("Você acertou k de n. Bora revisar o que faltou e tentar de novo.").
- Waiting: Capi curious, "Preparando o próximo passo…", skeleton lines; after 12 s "Tá demorando mais que o normal. Já já sai."

**Key PT-BR strings**

| Context | String |
|---|---|
| Subject home card | "Trilha guiada" · "Começar a trilha" · "Continuar a trilha" · "Capítulo {i} de {n}" · "Trilha concluída ✓" |
| Step labels | "Aula rápida" · "Outro jeito de ver" · "Pergunta" · "Tenta de novo, de outro jeito" · "Teste do capítulo · {i} de {n}" |
| Buttons | "Entendi, bora praticar" · "Verificar" · "Continuar" |
| Feedback | "Isso! ✅" · "Não foi dessa vez. A certa é a **{letter}**." · "Por que a {letter} não é" · "Por que a {letter} é a certa" · "Dica" · "Vou te explicar de outro jeito antes de seguir." |
| Test | "Hora do teste do capítulo: {n} perguntas. Acerte 70% pra concluir." · "Você acertou {k} de {n} no teste. Capítulo dominado!" |
| Done | "Capítulo concluído: {título} 🎉" · "Trilha concluída! 🏆" |
| Terms | "Toque nas palavras sublinhadas pra ver o significado." |

## 6. Data

| Table | Purpose |
|---|---|
| **`trails`** (new) [svc] | One per `(user_id, subject_id)`: `plan jsonb` (`TrailChapter[]`: `{topicId, why, conceptIds}` in path order), `goal`, `outline_hash`, `chapter_index`, `status` (`active` · `completed`), `prompt_version` (null = outline fallback), `preparing_until` (generation lease), `completed_at`. |
| **`trail_steps`** (new) [svc] | Every generated step: `topic_id`, `concept_id` (the topic itself when it has no concepts), `purpose` (`lesson` · `practice` · `remedial_lesson` · `remedial_question` · `checkpoint`), `round` (test round; 0 while learning), `for_step_id` (the wrong answer a remedial step repairs), `created_seq`, `served_seq`, `status` (`ready` · `done` · `discarded`), `content jsonb` (lesson `{title, body, terms}` or question `{stem, options[{id,text,rationale}], correct, explanation, tip, terms}`), `source_pages`, `response`, `correct`, `answered_at`, `prompt_version`. |
| `mastery_evidence.source` | add `trail` (`ref_type = trail_step`). |

Students select their own rows; only the API writes. Both tables are in the account export and are removed by account reset/deletion (FK cascade).

## 7. AI behavior

All calls: the default model and effort ([ai-pipeline §2](../engineering/ai-pipeline.md#2-model-and-request-policy)), PLT-04 budget (`user`), `ai_usage` row with feature `TRL-01`, structured output re-validated with Zod, page references validated against the pages sent.

| Task | Runs | Input | Output |
|---|---|---|---|
| `trail.plan` | Edge (trail-open) | Outline as data (units → topics with summary, objectives, concepts as short keys T1/C1), prerequisites, finished chapters | `{goal, chapters: [{topic_key, why, concept_keys[]}]}` (keys are schema enums) |
| `trail.lesson` | Edge (trail-prepare) | Topic pages (cached, 1 h), topic JSON, the concept, concepts already taught | `{lesson: {title, body, terms[], source_pages}, questions: [3 × {stem, options[4], correct, explanation, tip, terms[], source_pages}]}` |
| `trail.remediate` | Edge (trail-prepare) | Same + the missed question, the chosen option (untrusted data), stems already used | `{lesson, question}` |
| `trail.checkpoint` | Edge (trail-prepare) | Same + blueprint (concept key, count, weak), stems already used, round | `{questions: [{…question, concept_key}]}` |

The topic's pages are the cached prefix of every step of a chapter, so a chapter pays the document tokens once per hour.

## 8. Rules and algorithms

Pure functions in `packages/shared/src/learning/trail.ts` ([learning-engine §23](../engineering/learning-engine.md#23-trilha-trl-01)).

### 8.1 Path repair (`normalizeTrailPlan`)
Unknown and repeated topics/concepts are dropped, missing ones appended in outline order; then a stable topological sort (earliest proposed position first) puts every chapter after its prerequisites — concept edges across topics are lifted to their topics — and every concept after its in-topic prerequisites. Cycles are broken at the earliest remaining item. An empty proposal gives the outline order.

### 8.2 Next step (`nextTrailMove`)
1. A served step that is still open → show it again.
2. Learning phase, first concept not cleared (2 correct) or shaky (5 answers): its lesson → after a wrong answer, that answer's remedial lesson and question → the next practice question → out of questions: re-teach from the last miss.
3. All concepts cleared/shaky → chapter test round 1 (`checkpointBlueprint`: 1 per concept, +1 per weakness level, then round-robin to 2 per concept, 4–10).
4. Round finished: ≥ 70% → chapter passed; else re-teach up to 3 missed concepts (one pair each), then round r + 1.

### 8.3 Buffer (`trailNeeds`)
At most two needs, blocking first: the content the next move needs, then one lookahead (§4 TRL-01.8). `trail-prepare` generates one need per call under a 150 s lease, so two devices never generate the same step.

## 9. Edge cases and errors

| Case | Behavior |
|---|---|
| Subject without ready topics | trail-open → 404 "Essa matéria ainda não tem conteúdo pronto pra trilha…"; the card is hidden while the outline is empty. |
| `trail.plan` fails or is refused | Outline order, no goal line. |
| Generation fails for the step on screen | Error state with "Tentar de novo"; lookahead failures are silent. |
| Budget reached | Steps already generated keep working; the next new step shows the limit message (PLT-04.3). |
| Two devices at once | Unique trail per subject; the lease serializes generation; answers are idempotent per step. |
| Topic removed while in progress | Its chapter leaves the path at the next open; its steps stay in history. |

## 10. Metrics

Chapters finished per active student per week; share of concepts cleared without re-teaching; chapter-test pass rate on round 1; waits ("Preparando…" shown) per 100 steps; AI cost per finished chapter.

## 11. Acceptance criteria

- [ ] The subject home shows the Trilha card first; tapping it opens the path at the stored step.
- [ ] The plan never puts a chapter before one of its prerequisites (unit tests with concept-level edges and cycles).
- [ ] A wrong answer is followed by a remedial lesson and a new question before the next practice question.
- [ ] A concept is cleared after 2 correct answers; after 5 answers without that it is "pra revisar" and the path moves on.
- [ ] The chapter test has 4–10 questions, weights weak concepts, and passes at 70%; a failed round re-teaches and runs a new round.
- [ ] The answer and rationales never reach the app before the student answers.
- [ ] Answering the same step twice writes one mastery evidence row.
- [ ] Students cannot read or write another student's trail (pgTAP).

## 12. Open questions

- Should the Trilha feed the planner (Hoje learn blocks follow the path order)? Default: independent in v1.
- A "já sei isso" placement test that skips a chapter when passed? Default: not in v1 (strict path).
- Offline: download the next chapter's steps to the device? Default: online only in v1.
