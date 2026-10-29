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

**4. Long generations were awaited by the request that started them.** `ingest-start`, `ingest-retry`, `upload-photos`, `podcast-create`, ENEM `grade-essay`, `prova-provavel-generate`, `schedule-import` and `vespera-prepare` were designed as "202 and follow the job", but each awaited the whole generation before replying: the upload screen held its spinner until every topic was written. Material processing itself awaited the rendering and AI reading of every page before the outline, and treated Ache o Erro and problem sets as part of "material pronto". A restart failed every material it cut off. The Véspera sheet, documented as "pre-generated at D−1 04:00", was scheduled by nothing and only started when the student opened the eve screen.

**5. Every screen showed a wait its own way**, mostly a skeleton or a "Pensando…" with no step, no time and no end: a failed stream left some in their loading state for ever, an operation that returned without settling its `ai_jobs` row kept the app polling (and counted toward the three jobs a student may run), and failures showed a generic message.

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

### Long generations answer at once and report progress

- The endpoints above start their operation in the background and answer with its job at once. The operation's `ai_jobs` row is created by the request (removed when the work could not start), carries the step and, where the work is countable, the share done (pages, voice lines); an operation that created its own row marks it succeeded when it returns.
- A calendar trigger carries its key to the registry, so it joins a run of the same key that is still going instead of repeating it.
- Material processing starts page images and page transcription in the background and builds the outline from the PDF itself; "material pronto" means notes, glossary, cards and questions; Ache o Erro and problem sets follow (`ingest.topic_extras`). On start, the API schedules a resume for each material a restart interrupted, and the pipeline continues from what is written.
- `plan.nightly` schedules `vespera.prepare` for the start of each test's eve (the day rollover + 5 min), so the eve screen opens on the sheet.

### Material processing: the topic's slowest call, not the material's

Timed on a production material (11 pages, 5 topics, before these changes): 4 min 16 s to "pronto". Page rendering and the AI reading of every page held the outline back for 68 s; the outline took 20 s, the concepts of each topic 8–9 s, notes, glossary and cards 15–30 s, and **one call per topic writing its 15 questions (16–23k output tokens) 60–85 s**, which was most of the wait once the rest ran in parallel.

- A topic's question bank is written by up to three calls at once (`questions.generate@v3`), one per concept up to three: concepts are dealt in map order and question slots heaviest first, so the parts are about the same size and do not cover the same concept twice. A topic waits for its largest part. A resumed topic writes only the parts no question covers yet.
- Every ingestion and Trilha call of the server waits in one lane of `AI_WAVE_CONCURRENCY` calls (it was that many per material, plus the Trilha and extras on top): outlines first, then topics by their place in their material, so the first topics of a new upload start before the last topics of an older one, then background work (extras, Trilha content, page transcription, prerequisites, material check). Calls a student is waiting on in the app do not use the lane.
- A topic is open as soon as its own content is written. The processing screen lists the ready topics ("Já dá pra começar"), the subject's processing card and the live notification say how many are ready, and a topic finishing refreshes the outline at once.

Expected for the same material: about a minute (outline ~20 s, concepts ~9 s, then the topic's slowest call ~25–30 s); for a large one, the first topics in about a minute and the rest as the lane allows.

### One way to show a wait

Every generation screen shows its wait with one component (`GenerationStatus`): what is being made, the step, a bar filled from the progress the server reports (gliding when one long call reports none), elapsed time, the time left once a sixth is done, a "slower than usual" note, and — for background work — that the student can leave and will be told. Job rows arrive by Realtime and are merged into the screens' caches. Failures show the server's PT-BR message with a retry; every stream failure (network, deadline) reaches its screen. The lock-screen live notification updates at each step and at most every 30 s within one.

### Remember verified tokens briefly

`authenticate` verifies the access token with Supabase Auth (`auth.getUser`, which also reports a suspension) and remembers a verified token for at most 60 seconds or until it expires, whichever comes first, so a burst of requests from one session pays one verification. Suspending an account (`admin-user-control`) forgets its remembered tokens, so the suspension still takes effect at once. Verifying the signature locally (`auth.getClaims`) would save the remaining round trip, but a JWT does not carry the suspension, which would then wait for the token to expire.

## Alternatives considered

- **Keep writing the Trilha on demand with a deeper buffer.** Fewer waits for a fast student, but a miss still waits, the first open still waits, and every classmate still pays and waits again.
- **Write the whole Trilha for each student when they open a subject.** No waits after the first open, but the first open waits for minutes and the cost multiplies by the class size.
- **Write everything ahead, including a re-teaching aimed at every wrong option.** Three wrong options per question make it several times the content for a rare path; the feedback of the wrong option already explains it, and the shared re-explanation attacks the common confusions.
- **Fire-and-forget promises instead of the calendar.** Simpler, but lost on a restart and invisible to the drain on shutdown.
- **Lower effort or fewer questions per topic.** Each would shorten the slowest call further, but the effort per task and the size of the bank are product decisions with eval evidence (ai-pipeline §2.2), not a speed fix.
- **Fewer, larger model calls** (one call per Trilha concept for the lesson and what comes after it; one call per topic for notes, cards and questions). Output tokens set a call's duration, so one call writing two parts takes about as long as the two run one after the other and longer than the two in parallel, and the student waits for both parts to read the first; a failure loses both. The second Trilha call already reads the first one's cached material, so merging saves little. Calls are merged only where they repeat the same input with nothing to show in between; the gains here come from writing ahead and sharing what is written, not from fewer calls.

## Consequences

- Opening a subject's Trilha, reading a lesson, missing a question and starting a chapter test are database reads and writes, whether one student or a whole Turma takes the path.
- Each processed material pays for the Trilha of all its concepts: two calls per concept, about the cost of the topic's existing content again with the default model (ai-pipeline §9.5), whether or not a student opens the Trilha; in a Turma it is paid once instead of once per student.
- A student who opens the Trilha in the minutes between "material pronto" and the end of its Trilha content gets the first concept written on demand while the rest is written in the background.
- The re-explanation after a miss is the same for everyone and is not aimed at the chosen option; the option's own rationale, shown first, still is. The rare cases above keep the targeted calls.
- `quiz-submit`, `sync-push`, `flag-create`, `outline-edit` and the other call sites answer in milliseconds; their side work finishes a second or more later, which the app already shows as pending.
- A background trigger claimed by the calendar and interrupted by a crash is lost, like any calendar action (ADR 0010); grading stays pending and the Trilha content is written on demand or by the next open. An interrupted material is resumed on start; an ENEM redação whose grading was lost can be sent again.
- Upload, podcast, grading, Prova provável and schedule-import requests answer in about a second; the app follows the job row, and the student may leave the screen.
- Each test's Véspera sheet is paid for on its eve whether or not the student opens it.
- Splitting the question bank sends the topic's pages three times instead of once (input tokens, a small share of the cost next to the output); the output is the same size.
- With several uploads at once, each one finishes later than it would alone, and each one's first topics arrive sooner.
