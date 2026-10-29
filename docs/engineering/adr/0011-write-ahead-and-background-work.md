# 0011 — Write content ahead, keep side work in the background

| Status | Accepted |
|---|---|
| Date | 2026-10-29 |
| Related | [0010 — Direct SSE API](0010-direct-sse-api.md) · [Spec 14 — Trilha](../../specs/14-trilha.md) · [AI pipeline](../ai-pipeline.md) · [API](../api.md) |

## Context

Students report that the app is slow everywhere, and that it seems to generate everything only when they ask for it. The code confirms two structural causes and one smaller one.

**1. The Trilha is written live, step by step, for each student.** Spec 14 chose "content is written on demand, one concept ahead". Every lesson with its questions (`trail.lesson`), every re-teaching after a miss (`trail.remediate`) and every chapter test (`trail.checkpoint`) is a model call made while the student waits on "Preparando o próximo passo…", and the first open also waits on `trail.plan`. The buffer writes one step per `trail-prepare` call, serialized by a lease and driven by the app, so a student who moves faster than the buffer waits again; a miss always waits, because its re-teaching can only be written after it happens. All of it is repeated for every classmate: a Turma of 30 pays for and waits on the same lesson 30 times, against the platform rule "generated once, used by everyone" (architecture §3.2). Meanwhile notes, cards, questions and the glossary of every topic are already written while the material is processed.

The buffer also had a correctness bug: the chapter test it wrote ahead while the student was on the last concept made `nextTrailMove` start the test as soon as that concept's lesson was read, skipping its practice questions.

**2. Side work blocks requests.** ADR 0010 replaced the job queue with direct execution: `execute()` now runs an operation and awaits it. Call sites written for an enqueue kept their `await`, so requests wait on work the app never waits for. `quiz-submit` graded every AI-graded answer one after another before answering (the result screen already polls pending answers); `sync-push` held the review outbox on AI grading and on flag triage; `flag-create` waited on triage (api.md: "no AI in request"); `outline-edit` regenerated every merged or split topic inline; the last topic of a material waited on the prerequisites call and the material check before its own content and before "material pronto"; Turma pushes and reports waited on Expo; a duel answer waited on a mastery recompute.

**3. Every request verified its token over the network** (`auth.getUser`), a round trip to Supabase Auth before any work.

## Decision

### Write the Trilha ahead, once per subject

- When a material is ready, `trail.prepare_topic` starts in the background for each of its topics and writes each concept's shared content into `trail_concept_content`: the lesson with its three practice questions (`trail.lesson`), then what comes after it (`trail.reinforce`, new): a re-explanation from another angle, three fresh questions for after a miss, and four chapter-test questions. After the prerequisites, `trail.plan_subject` writes the subject's path (`trail.plan`) into `trail_subject_plans`. Both are subject content: charged to the `content` budget like notes and cards, shared by every student of the subject, and written only when missing (a resumed or regenerated material pays for nothing twice). Starting after the material is ready means the Trilha only spends what the material's own content left of that budget: it can never park a material as `waiting_budget`.
- A student's trail copies its steps from that content as soon as the path needs them (`buildState`, in every Trilha call): the lesson and its questions, the re-explanation and a fresh question after a miss (later misses on the same concept get the next fresh question alone), the chapter test from the concepts' test questions, weighted by the same blueprint. No model call, no `preparing`, no `trail-prepare` round trip.
- `trail-open` never calls Claude. The path is the subject's path repaired against the student's map (exclusions, new topics) with `normalizeTrailPlan`, or the outline order until the subject's path exists; a trail that started in outline order takes the subject's path for the chapters it has not started once it exists.
- Model calls remain only for what the shared content does not cover: a concept whose content is not written yet (a subject processed before this decision, or a failed call), a fourth miss on one concept, a chapter-test round after the shared test questions are used up. A lesson written that way goes into the shared content, so it is written once. When `trail-open` finds the current or the next chapter incomplete, it starts `trail.prepare_topic` for them in the background, so older subjects fill in as students reach them.
- Two requests copying the same step collide on `(trail_id, created_seq)`; the second re-reads the steps and finds the step there, so a step is never stored twice.
- `nextTrailMove` starts the chapter test only when every concept is cleared or shaky.

### Side work starts in the background

- `inBackground` (API) and `startAfter: 0` (server operations) register a calendar trigger due now: the operation starts within about a second, survives an API restart that happens before it starts, and adds nothing to the request. `execute` without a start time still runs an operation and awaits it, for the operations whose result the stream reports (ingestion, essay grading, podcasts).
- Background now: AI grading from `quiz-submit` and `sync-push`, flag triage, Turma pushes and report notifications, topic regeneration from `outline-edit`, `divide.merge`, `account.export`, the prerequisites and the material check of a material, and the Trilha content. A duel answer debounces `mastery.recompute` by 60 s like every other evidence writer.
- A calendar trigger refused at its operation's concurrency limit is re-scheduled five seconds later with the same key instead of being dropped.

### Verify tokens locally

`authenticate` verifies the access token's signature locally when the project's signing keys allow it (`auth.getClaims`, JWKS cached by supabase-js) and keeps a verified token for at most 60 seconds or until it expires, whichever comes first, so a burst of requests from one session pays one verification.

## Alternatives considered

- **Keep writing the Trilha on demand with a deeper buffer.** Fewer waits for a fast student, but a miss still waits, the first open still waits, and every classmate still pays and waits again.
- **Write the whole Trilha for each student when they open a subject.** No waits after the first open, but the first open waits for minutes and the cost multiplies by the class size.
- **Write everything ahead, including a re-teaching aimed at every wrong option.** Three wrong options per question make it several times the content for a rare path; the feedback of the wrong option already explains it, and the shared re-explanation attacks the common confusions.
- **Fire-and-forget promises instead of the calendar.** Simpler, but lost on a restart and invisible to the drain on shutdown.

## Consequences

- Opening a subject's Trilha, reading a lesson, missing a question and starting a chapter test are database reads and writes, whether one student or a whole Turma takes the path.
- Each processed material pays for the Trilha of all its concepts: two calls per concept, about the cost of the topic's existing content again with the default model (ai-pipeline §9.5), whether or not a student opens the Trilha; in a Turma it is paid once instead of once per student.
- A student who opens the Trilha in the minutes between "material pronto" and the end of its Trilha content gets the first concept written on demand while the rest is written in the background.
- The re-explanation after a miss is the same for everyone and is not aimed at the chosen option; the option's own rationale, shown first, still is. The rare cases above keep the targeted calls.
- `quiz-submit`, `sync-push`, `flag-create`, `outline-edit` and the other call sites answer in milliseconds; their side work finishes a second or more later, which the app already shows as pending.
- A background trigger claimed by the calendar and interrupted by a crash is lost, like any calendar action (ADR 0010); grading stays pending and the Trilha content is written on demand or by the next open.
