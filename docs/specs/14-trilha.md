# 14 — Trilha (guided path)

| Status | Phase(s) | Features |
|---|---|---|
| Draft v1 | 5 | TRL-01 |

Related: [PRD](../product/PRD.md#515-trilha-trl) · [01 — Ingestion & knowledge map](01-ingestion-knowledge-map.md) (the outline, prerequisites) · [02 — Learn](02-learn-notes.md) (Explica de outro jeito) · [03 — Tutor](03-tutor.md) · [04 — Flashcards](04-flashcards-memory.md) · [05 — Practice & exams](05-practice-exams.md) (question rules, Caderno de Erros) · [12 — Interactive learning](12-interactive-learning.md) (Ensine o Lucas) · [13 — Motivation](13-motivation-wellbeing.md) (skill tree, Chefão) · [learning-engine.md](../engineering/learning-engine.md#23-trilha-trl-01)

---

## 1. Summary

A Duolingo-style path through one subject. The app decides the order in which the whole course should be learned, then teaches it one concept at a time: a short explanation, questions right after it, feedback that teaches, a different explanation when the student misses, and a chapter test at the end of each topic that must be passed — then the student teaches the topic to Lucas to close the chapter. The path ties the rest of the app together: the tutor and "Explica de outro jeito" on every step, misses in the Caderno de Erros, what was learned first in the flashcard reviews, and the unit's Chefão when a unit is done. Key terms are underlined and explained on tap. The path is persistent: the student can leave at any step and resume exactly there. Its content is written ahead, once per subject, while the material is processed, and shared by every student of the subject ([ADR 0011](../engineering/adr/0011-write-ahead-and-background-work.md)): the student never waits on a model call to move on.

## 2. Goals and non-goals

**Goals**
- One obvious thing to do in a subject: "Continuar a trilha".
- Order matters: fundamentals before what depends on them, across the whole subject.
- Retrieval right after teaching, and re-teaching on mistakes, so a chapter is marked done only when it was understood.
- No waiting: every step is written before the student reaches it, and a Turma pays for it once.

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
- **TRL-01.2** Path: once a material's map and prerequisites are written, `trail.plan` reads the subject outline (units, topics, objectives, concepts) and the prerequisites and returns the chapter order (one chapter per topic) and the concept order inside each, with a "por que agora" per chapter and a one-line goal, stored for the subject. Each student's path is that order repaired for their map (§8.1): excluded topics ("não cai na prova"), placeholders and topics without pages are left out. Until the subject's path exists (or when the call failed), the outline order is used, and a trail that started that way takes the subject's path for the chapters it has not started once it exists. Opening never waits on a model call.
- **TRL-01.3** Outline changes: when the outline the plan was built from changed (new material, outline edits, exclusions), the next open keeps the finished chapters and the one in progress in place (with their concept lists refreshed) and plans the rest again.
- **TRL-01.4** Lesson: each concept starts with a lesson — a title and 60–160 words of Markdown with the central idea first, 2–4 bullet points, a concrete example, formulas in LaTeX and page chips (📄). "Entendi, bora praticar" moves on.
- **TRL-01.5** Questions: multiple choice, 4 options, select then "Verificar". Feedback in place: right/wrong, why the chosen option is wrong, why the right one is right, the explanation, an optional tip, 📄. A concept is cleared after **2 correct answers**. Answers are mastery evidence (source `trail`, weight 1.0).
- **TRL-01.6** Re-teaching: after a wrong answer the next step is a new explanation from another angle, aimed at the confusion the chosen option reveals, followed by a fresh question on the same point. After **5 answers** without clearing, the concept is marked "pra revisar" and the path moves on (the chapter test still gates).
- **TRL-01.7** Chapter test: once every concept of the chapter is cleared or "pra revisar", a test of 2 questions per concept (4–10), weighted toward the weak concepts, mixed. Pass at **70%** (the Chefão bar). A failed round re-teaches up to 3 missed concepts (explanation + question each), then runs a new round with new questions. Passing finishes the chapter; the last chapter finishes the Trilha.
- **TRL-01.8** Content written ahead: as soon as a material is ready, each concept of its topics gets a lesson with 3 questions (2 asked, 1 spare), a re-explanation from another angle with 3 fresh questions for after a miss, and 4 chapter-test questions, stored once for the subject and shared by every student. A trail copies the steps it needs from there the moment it needs them: the lesson and its questions, the re-explanation and a fresh question after a miss (a later miss on the same concept gets the next fresh question alone), the chapter test by the blueprint (§8.2). What that content does not cover (a subject processed before it existed, a fourth miss on one concept, a chapter-test round after its questions are used up) is written on demand as before; a lesson written that way joins the shared content, and opening a subject whose current or next chapter is incomplete starts writing the rest in the background. The buffer (`TRAIL.lookahead`) and the app's background prefetch apply only to those on-demand cases; the app shows "Preparando o próximo passo…" only when the step it needs isn't ready, and that screen is the whole wait: "Entendi, bora praticar" and "Continuar" never spin first. On a lesson, the state also carries the step after it (`next_step`): "Entendi, bora praticar" shows it at once and records the lesson behind it, so the student never waits on the server to move on.
- **TRL-01.9** Key terms: each lesson and question carries up to 6 key terms with one-sentence definitions; the first occurrence is underlined (dotted, ux §7.3) and opens a sheet with the definition.
- **TRL-01.10** Resume: the step on screen is stored as served; leaving and opening again shows the same step. Answering a step twice never grades it twice.
- **TRL-01.11** Path view: "Ver a trilha" lists the chapters (done, now, later) with their "por que agora", and the concepts of the current chapter with their state.
- **TRL-01.12** Ensine o Lucas closes every chapter (required): after the chapter test is passed, the student teaches the topic to Lucas (INT-02, Rápido). The chapter finishes when a finished lesson on that topic scored **≥ 70** (the "good" band, spec 12 §5.2); a lower score asks for another lesson (Lucas brings different misconceptions, INT-02.9). Coming back to the Trilha checks it and moves on.
- **TRL-01.13** Caderno de Erros: every missed Trilha question is saved as a personal bank question, answered in the trail's implicit attempt (`quizzes.kind = trail`), and becomes a mistakes row with its remediation card (PRA-02, PRA-04), so it comes back as a Caderno retry. Feedback says "Guardei essa no seu Caderno de Erros…". Saving is best effort and never fails the answer.
- **TRL-01.14** Chefão: when every chapter of a unit (at least 2 in the path) is done and its Chefão (MOT-02.4) is not defeated yet, the chapter-done screen, the end screen and the path view offer "Enfrentar o Chefão: {unidade}" (optional).
- **TRL-01.15** Flashcards: concepts cleared in the Trilha (and every concept of a finished chapter) go first among the day's new cards in the review queue (after exam-scoped cards, within the new-card limit), so what was just understood enters spaced review. The chapter-done screen offers "Revisar os cartões".
- **TRL-01.16** Help on every step: lessons show "Explica de outro jeito" (LRN-03, target `trail_step`) and "Perguntar ao tutor" (topic scope); after a wrong answer the feedback shows "Não entendi" (tutor, with the question prefilled) and "Explica de outro jeito". A question can only be re-explained once answered.

## 5. UX and screens

- **S-TRL-01 Trilha** (immersive, from the subject home): header with the whole-path progress bar and "Capítulo i de n · {tópico}"; action "Ver a trilha" (map icon). Body: one step. Footer: one primary button ("Entendi, bora praticar" · "Verificar" · "Continuar").
- Milestones between steps: test passed ("…Falta só um passo: ensinar pro Lucas."), chapter done (Capi celebrating, "Próximo: {capítulo}", "Enfrentar o Chefão" when a unit is done, "Revisar os cartões"), failed test ("Você acertou k de n. Bora revisar o que faltou e tentar de novo.").
- Lucas step: "Último passo do capítulo" · "Ensine {tópico} pro Lucas" · the pass score and the best score so far · "Ensinar o Lucas" opens S-INT-03 on the topic.
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
| **`trail_concept_content`** [svc] | One per concept (the topic itself when it has no concepts), shared by the subject: `lesson`, `practice` (3), `remedial_lesson`, `remedial_questions` (3), `test_questions` (4), each with its `source_pages`; `prompt_version` (trail.lesson), `reinforce_prompt_version` (trail.reinforce, null until written). Service only. |
| **`trail_subject_plans`** [svc] | One per subject: `chapters` (`ProposedChapter[]`), `goal`, `outline_hash` (of the subject's map before any exclusion), `prompt_version`. Service only. |
| **`trail_steps`** (new) [svc] | Every generated step: `topic_id`, `concept_id` (the topic itself when it has no concepts), `purpose` (`lesson` · `practice` · `remedial_lesson` · `remedial_question` · `checkpoint`), `round` (test round; 0 while learning), `for_step_id` (the wrong answer a remedial step repairs), `created_seq`, `served_seq`, `status` (`ready` · `done` · `discarded`), `content jsonb` (lesson `{title, body, terms}` or question `{stem, options[{id,text,rationale}], correct, explanation, tip, terms}`), `source_pages`, `response`, `correct`, `answered_at`, `prompt_version`. |
| `trails.quiz_attempt_id` | The implicit attempt (`quizzes.kind = trail`, status `submitted`) that holds the answers sent to the Caderno. |
| `trail_steps.question_id` | The bank question a missed step was saved as. |
| `mastery_evidence.source` | add `trail` (`ref_type = trail_step`). |
| `quizzes.kind` | add `trail`. |
| `explanations.target_type` | add `trail_step` (LRN-03 on a Trilha step). |

Students select their own rows; only the API writes. Both tables are in the account export and are removed by account reset/deletion (FK cascade).

## 7. AI behavior

All calls: the default model and effort ([ai-pipeline §2](../engineering/ai-pipeline.md#2-model-and-request-policy)), PLT-04 budget (`user`), `ai_usage` row with feature `TRL-01`, structured output re-validated with Zod, page references validated against the pages sent.

| Task | Runs | Input | Output |
|---|---|---|---|
| `trail.plan` | Worker (`trail.plan_subject`, after the prerequisites; `content` budget) | Outline as data (units → topics with summary, objectives, concepts as short keys T1/C1), prerequisites | `{goal, chapters: [{topic_key, why, concept_keys[]}]}` (keys are schema enums) |
| `trail.lesson` | Worker (`trail.prepare_topic`, once the material is ready; `content` budget); Edge (trail-prepare) for a concept not written yet | Topic pages, topic JSON, the concept, concepts taught before it in the path | `{lesson: {title, body, terms[], source_pages}, questions: [3 × {stem, options[4], correct, explanation, tip, terms[], source_pages}]}` |
| `trail.reinforce` | Worker (`trail.prepare_topic`, right after the concept's lesson) | Same + the lesson already written, its question stems | `{lesson, remedial_questions: [3 × question], test_questions: [4 × question]}` |
| `trail.remediate` | Edge (trail-prepare), when the concept's fresh questions are used up | Same + the missed question, the chosen option (untrusted data), stems already used | `{lesson, question}` |
| `trail.checkpoint` | Edge (trail-prepare), when the shared test questions cannot fill a round | Same + blueprint (concept key, count, weak), stems already used, round | `{questions: [{…question, concept_key}]}` |

The topic's pages are the cached prefix of every call of a topic: the concept calls written ahead run within minutes of each other and read the same cache.

## 8. Rules and algorithms

Pure functions in `packages/shared/src/learning/trail.ts` ([learning-engine §23](../engineering/learning-engine.md#23-trilha-trl-01)).

### 8.1 Path repair (`normalizeTrailPlan`)
Unknown and repeated topics/concepts are dropped, missing ones appended in outline order; then a stable topological sort (earliest proposed position first) puts every chapter after its prerequisites — concept edges across topics are lifted to their topics — and every concept after its in-topic prerequisites. Cycles are broken at the earliest remaining item. An empty proposal gives the outline order.

### 8.2 Next step (`nextTrailMove`)
1. A served step that is still open → show it again.
2. Learning phase, first concept not cleared (2 correct) or shaky (5 answers): its lesson → after a wrong answer, that answer's remedial lesson and question → the next practice question → out of questions: re-teach from the last miss.
3. All concepts cleared/shaky → chapter test round 1 (`checkpointBlueprint`: 1 per concept, +1 per weakness level, then round-robin to 2 per concept, 4–10).
4. Round finished: ≥ 70% → test passed; else re-teach up to 3 missed concepts (one pair each), then round r + 1.
5. Test passed → the chapter waits for Ensine o Lucas on the topic (best finished score ≥ `TRAIL.teachPassScore` = 70), then the path moves to the next chapter.

A chapter test written ahead (the buffer writes it while the student is on the last concept) waits until every concept is cleared or shaky: its questions never cut a concept's practice short.

### 8.3 Shared content and buffer (`trailNeeds`)
Every Trilha call first copies the next move's steps from the shared content (`bankStepsFor`), so the state is `preparing` only when that content does not cover the move. For those cases, at most one blocking need, then `TRAIL.lookahead` (2) lookaheads within the chapter (§4 TRL-01.8); `prefetch` is set only for lookaheads the shared content does not cover. `trail-prepare` generates one need per call under a 150 s lease, so two devices never generate the same step; two requests copying the same step collide on the creation number and the second re-reads, so a step is never stored twice.

## 9. Edge cases and errors

| Case | Behavior |
|---|---|
| Subject without ready topics | trail-open → 404 "Essa matéria ainda não tem conteúdo pronto pra trilha…"; the card is hidden while the outline is empty. |
| `trail.plan` fails or is refused | Outline order, no goal line. |
| Generation fails for the step on screen | Error state with "Tentar de novo"; lookahead failures are silent. |
| Subject processed before content was written ahead | The first concept is written on demand (into the shared content); opening starts writing the rest of the current and next chapter in the background. |
| Budget reached | Steps already written (shared content included) keep working; a step that still needs a call shows the limit message (PLT-04.3). Content written ahead stops for the material and is written on demand later. |
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
- [ ] A question's answer and rationales travel with the step, so the verdict and the explanation show at once; the server records the answer when the student answers (trail-grade) and never grades it again.
- [ ] Answering the same step twice writes one mastery evidence row.
- [ ] Students cannot read or write another student's trail (pgTAP).
- [ ] After the test is passed the chapter stays open until a Lucas lesson on the topic scores ≥ 70; a lesson at 55 is not enough.
- [ ] A missed Trilha question appears in the Caderno de Erros with its remediation card.
- [ ] Finishing every chapter of a unit offers its Chefão until it is defeated.
- [ ] The cards of a concept cleared in the Trilha are the first new cards of the next review, even when older new cards exist.

## 12. Open questions

- Should the Trilha feed the planner (Hoje learn blocks follow the path order)? Default: independent in v1.
- A "já sei isso" placement test that skips a chapter when passed? Default: not in v1 (strict path).
- Should a passed Chefão be required before the next unit? Default: optional (Lucas is the required step).
- Offline: download the next chapter's steps to the device? Default: online only in v1.
