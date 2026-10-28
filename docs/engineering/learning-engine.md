# Studify — Learning Engine

| | |
|---|---|
| **Status** | Draft v1 — normative. Where a spec's §8 differs, this document wins and §22 lists the spec text to update. |
| **Scope** | Every deterministic algorithm: FSRS and exam-aware scheduling, new-card quota, mastery, question selection, Caderno de Erros, calibration, Prova Provável models, Feed ranking, the planner, the session builder, readiness and predicted grade, "Quanto preciso tirar?", TRI and SISU math, Mapa da Memória, skill tree, XP/streaks, duel/battle scoring, class insights, Lucas scoring, burnout heuristics and energy-aware windows. |
| **Not here** | Model calls ([ai-pipeline.md](ai-pipeline.md)). Nothing in this document calls Claude. |
| **Related** | Specs [04](../specs/04-flashcards-memory.md), [05](../specs/05-practice-exams.md), [06](../specs/06-feed-de-estudos.md), [07](../specs/07-goals-semana-de-provas.md), [08](../specs/08-prova-provavel.md), [09](../specs/09-enem-mode.md), [10](../specs/10-turma-social.md), [12](../specs/12-interactive-learning.md), [13](../specs/13-motivation-wellbeing.md) · [Testing strategy §3](testing-strategy.md#3-unit-tests-packagesshared) |

---

## 0. Conventions

### 0.1 Where the code lives and runs

All algorithms are **pure TypeScript functions** in `packages/shared/learning/*`, with no I/O: callers load inputs and persist outputs. The same package version runs on the device, in Edge Functions and in the worker, so the same inputs give the same outputs everywhere.

| Algorithm | Runs on | Why |
|---|---|---|
| FSRS scheduling, review queue, exam overlay, new-card quota (read side) | **Device** (SQLite inputs); worker replays for authoritative `card_states` | Offline reviews (PLT-07, ADR 0004/0007) |
| Mastery (live read) | Device (from local card states + evidence aggregates); worker writes aggregates | UI needs "now" values offline |
| Mastery aggregates, mastery-shift detection | Worker (after sync) | Single writer |
| Feed ranking, session builder, calibration display | Device | Offline Feed / Hoje |
| Planner `buildPlan` | Worker (on triggers, §11.7); device runs it for an offline preview with the same inputs | Determinism + offline |
| Readiness, predicted grade, snapshots | Worker nightly + on grade logging; device reads | |
| Quanto preciso tirar? | Device and Edge (same code) | Instant feedback |
| Prova Provável weights/blueprint, ENEM topic stats | Worker | Bulk data |
| TRI estimate, coherence, SISU targets | Edge (on simulado submit) / device preview | |
| Duel and battle scoring | Edge / worker (server-measured time) | Anti-cheat (SOC-02, SOC-03) |
| Class insights thresholds | **SQL RPC** `class_insights_for` | Anonymity enforced in the database (SOC-04) |
| XP, streaks, levels | Worker from synced events (device shows optimistic values) | Idempotent server truth |
| FSRS parameter optimization | Worker weekly | Heavy |

### 0.2 Time

- **Study day.** One rollover hour for every feature: `day_rollover_hour = 04:00` local (MEM-02.13, spec 07 §8.1). Activity at 01:30 belongs to the previous study day. `studyDay(t, tz)` is the only function allowed to turn a timestamp into a day. (Spec 13 used 03:00 for streaks — reconciled in §22, L2.)
- **Time zone** from `profiles.settings.timezone` (default `America/Sao_Paulo`). Plans use local dates; `days_until(E) = studyDay(E.starts_at ?? E.local_date) − studyDay(now)` in whole days.
- Timestamps from devices are clamped to server receive time when > 5 min in the future (raw value kept in `client_reviewed_at`, flag `clock_skew`) — spec 04 §8.8, mobile-app §4.3.

### 0.3 Determinism

- No `Math.random()`. Randomness uses a seeded PRNG (`mulberry32(hash32(seedParts.join("|")))`).
- Ties are broken by stable keys (knowledge-map order, then id).
- Every function documents its parameters with defaults; defaults live in `packages/shared/learning/params.ts` and can be overridden server-side (`feature_flags` / `profiles.settings`), never silently on device.

### 0.4 Notation

`σ(x) = 1 / (1 + e^(−x))` · `clamp(x, lo, hi)` · `ceil5(x)` = round up to a multiple of 5 · `normalize(v)` = `v / Σ v` · `decay_H(Δ) = 0.5^(Δ_days / H)` · `E` exam, `n` topic, `c` concept, `m` mastery, `R` FSRS retrievability.

## 1. Contracts

Function signatures other specs depend on. Types are from `packages/shared/types`.

```ts
// §2–3  FSRS and review queue (MEM-02)
scheduleReview(state: CardState, rating: 1|2|3|4, at: Instant, params: FsrsParams): { next: CardState; log: ReviewLogDraft };
replayCard(logs: ReviewLog[], params: FsrsParams): CardState;              // server authority (§2.6)
effectiveDue(card: CardRef, state: CardState, exams: ExamScope[], now: Instant, p: Params): Instant; // min(fsrs_due, exam_due) (§3.2)
buildReviewQueue(input: QueueInput, now: Instant): QueueEntry[];           // §3.1
forecastReviewLoad(userId: UserId, fromDate: LocalDate, toDate: LocalDate): Array<{
  date: LocalDate; dueCount: number; examBoostCount: number; estMinutes: number }>;   // §3.4
newCardQuota(userId: UserId, date: LocalDate): { total: number; bySubject: Record<SubjectId, number>;
  required: number; capped: boolean };                                       // §4
activeExamScopes(userId: UserId, date: LocalDate): Array<{ examId: ExamId; localDate: LocalDate;
  weightNorm: number; nodeIds: NodeId[] }>;                                  // tests in the next 14 days

// §5  Mastery
recordEvidence(ev: EvidenceEvent): void;                                     // worker; idempotent on ev.id
masteryAt(userId: UserId, nodeId: NodeId, t: Instant): {
  mastery: number | null; retrievability: number | null;
  retrievabilitySource: "cards" | "questions" | null; evidenceCount: number; studied: boolean };
predictSuccess(userId: UserId, questionId: QuestionId, t: Instant): number;  // p̂ (§6.1)
examUrgency(userId: UserId, conceptId: NodeId, t: Instant): number;         // §6.2

// §7–8  Caderno de Erros, calibration
suggestCause(answer: AnswerFacts): MistakeCause;                             // §7.1
nextRetry(mistake: Mistake, outcome?: "correct" | "wrong"): LocalDate | "resolved"; // §7.3
calibration(answers: RatedAnswer[]): CalibrationReport;                      // §8

// §9  Prova Provável
teacherTopicWeights(exam: Exam, profile: TeacherProfile, baseWeights: Record<NodeId, number>): Record<NodeId, number>;
predictedTestBlueprint(exam: Exam, profile: TeacherProfile, weights: Record<NodeId, number>, seed: string): Slot[];
enemTopicStats(items: EnemItem[], editions: Edition[]): EnemTopicStat[];

// §10  Feed
rankFeed(pools: FeedPools, ctx: FeedContext, now: Instant): FeedRound[];

// §11–14  Planning and grades
buildPlan(input: PlanInput, trigger: PlanTrigger): PlanRun;                  // §11
buildSession(input: SessionInput, targetMinutes: number): SessionPlan;      // §12
readiness(userId: UserId, examId: ExamId, at: Instant): { value: number; coveredWeight: number; perTopic: Record<NodeId, number> };
predictedGrade(userId: UserId, examId: ExamId): { grade: number; lo: number; hi: number } | "not_enough";
requiredGrade(rules: GradingFormula, grades: GradeComponentState[], target: GradeTarget):
  { kind: "secured" } | { kind: "required"; value: number } |
  { kind: "impossible"; recovery?: number; finalExam?: number };

// §15  ENEM
triEstimate(responses: ItemResponse[], items: EnemItemParams[]): { score: number; lo: number; hi: number; theta: number; se: number };
coherence(responses: ItemResponse[], items: EnemItemParams[], theta: number): CoherenceReport;
sisuTargets(input: SisuInput): Record<"LC"|"CH"|"CN"|"MT"|"RED", number> | "already_above" | "too_high";

// §16–20  Map, motivation, social, interactive, wellbeing
xpFor(event: XpEvent, todayContext: XpDayContext): number;
evaluateStreak(days: DailyActivity[], state: StreakState): StreakState;
levelFor(totalXp: number): number;
duelPoints(correct: boolean, tSeconds: number, limit: number): number;
battlePoints(correct: boolean, tSeconds: number, limit: number, answerStreak: number): number;
classInsightDisplay(agg: InsightAggregate): InsightDisplay;                  // mirrored in SQL
lucasScore(evaluation: LucasEvaluationState, turns: number): number | "too_short";
burnoutNudges(activity: ActivityWindow, now: Instant): Nudge[];
```

## 2. FSRS (MEM-02)

### 2.1 Configuration

| Parameter | Default | Range / note |
|---|---|---|
| Library | `ts-fsrs`, version pinned in `packages/shared` (same on device and worker) | MEM-02.1 |
| Ratings | 1 **Errei** (Again) · 2 **Difícil** (Hard) · 3 **Bom** (Good) · 4 **Fácil** (Easy) | MEM-02.2 |
| Desired retention `r_target` ("Meta de lembrança") | 0.90 | 0.80–0.95 (MEM-02.3) |
| Learning steps | 1 min, 10 min | |
| Relearning steps | 10 min | |
| Maximum interval | 365 days | |
| New cards per day (no active plan) | 20 | Overridden by §4 when a plan exists |
| Maximum reviews per day | 200 | |
| Fuzz | ts-fsrs fuzz **on** (seeded per card id so replays are deterministic) | Avoids review clumping |
| Default weights | ts-fsrs defaults until §2.5 adopts personal weights | |

### 2.2 Review events

Every review appends one `review_logs` row (append-only): `{id (client UUID v7), user_id, card_id, rating, reviewed_at, client_reviewed_at, duration_ms (stats capped at 60 s), source, reason, device_id, undoes_log_id?, hint_used?}`.

- `source ∈ {session, feed, widget, notification, map, vespera}` (MEM-02.9). Feed swipes map per spec 06 §8.4 (right = 3, left = 1, long-press = any; swipe-up on a due card = skip, no log).
- `reason ∈ {due, exam_boost, early, learning}`. `early` = reviewed before its effective due (e.g. tapping a card on the Mapa da Memória).
- **Undo** (MEM-02.8) appends a log with `undoes_log_id`; replay ignores the pair.
- **Siblings** (MEM-02.7): after a review, cards with the same `sibling_group_id` are buried until the next study day.

### 2.3 Leeches (MEM-02.12)

`is_leech = lapses ≥ 6`, re-prompted at lapses 9, 12, … On the next lapse of a leech the app shows "Esse cartão tá difícil de fixar" with: rewrite, create a mnemonic (MEM-06), "Explica de outro jeito" (LRN-03), suspend. Never auto-suspend.

### 2.4 Backlog recovery (MEM-02.16)

When `due_count > 3 × max_reviews_per_day`, offer **Modo recuperação**: `daily_cap = ceil(due_count / min(7, ceil(due_count / max_reviews_per_day)))`, selection by §3.1 priority; new cards pause (`newCardQuota.total = 0`) until `due_count < max_reviews_per_day`.

### 2.5 Personal parameter optimization (MEM-02.14)

```
weekly, for users with valid_logs ≥ 1,000
  valid_logs = logs − undone pairs − (reason = early within 10 min of the previous review of that card)
  split chronologically: train = first 80%, test = last 20%
  w_new = fsrsOptimize(train)                        // official FSRS optimizer
  adopt if logloss(test, w_new) ≤ 0.99 × logloss(test, w_current)
  on adopt: profiles.settings.memory.fsrs_params = {version+1, w_new}
            device reschedules existing due dates with ts-fsrs reschedule on next sync (history kept)
```

The optimizer is the official FSRS implementation (fsrs-rs via a Node binding, per spec 04 §8.6). **Unverified:** that a maintained Node binding exists for the pinned version; fallback is the Python `fsrs-optimizer` run as a worker sidecar job with the same inputs/outputs. Changing "Meta de lembrança" also triggers reschedule (MEM-02.15).

### 2.6 Offline replay and merge (ADR 0007)

```ts
function replayCard(logs: ReviewLog[], params: FsrsParams): CardState {
  const kept = dropUndonePairs(logs)
    .map(clampFutureTimestamp)                                  // §0.2
    .sort(byReviewedAtThenId);
  const dedup = dropCrossDeviceDoubles(kept, 60_000);            // same card, different device, < 60 s apart → ignore the later
  let state = newCardState();
  for (const log of dedup) state = scheduleReview(state, log.rating, log.reviewed_at, params).next;
  return state;                                                  // authoritative; device replaces its local prediction
}
```

- Server inserts logs `ON CONFLICT (id) DO NOTHING` and replays the affected (user, card).
- Same-device logs are never deduplicated (a quick Errei → Bom sequence is legitimate learning steps).
- `card_states` is always derivable from `review_logs` (spec 04 §8.8).

## 3. Review queue and exam-aware scheduling

### 3.1 Queue (spec 04 §8.3)

```
input: introduced + new cards of active subjects (excluding suspended, hidden, archived, buried siblings)
now_day_end = end of current study day
1. learning/relearning cards whose step is due (by due time)
2. due reviews: effectiveDue(card) ≤ now_day_end
     order: effectiveDue ascending, then R_now ascending
     if count > daily_cap (max_reviews_per_day, or recovery cap §2.4):
        keep top daily_cap by priority = (1 − R_now) × (1 + exam_factor)
        exam_factor = weight_norm(E) × (1.0 if days_until(E) ≤ 7; 0.5 if ≤ 14; else 0)
        (E = earliest active exam whose scope contains the card's concept)
3. new cards up to newCardQuota(today).total − introduced_today
     order: soonest exam first, then knowledge-map order (unit → topic → concept)
     interleave: 1 new after every 4 reviews
```

`weight_norm(E) = E.weight / max weight among the goal's scheduled exams` (0–1].

### 3.2 Exam overlay (MEM-02.5, spec 04 §8.5)

Applies to exams with `starts_at` (or `local_date` at 07:00 when no time) within the next **14 days**, `status = scheduled`.

```ts
function examDue(card, state, exam, now, p): LocalDate | null {
  if (!state.introduced || state.suspended) return null;
  const T = exam.startsAt;
  if (state.fsrsDue < dayBefore(T, 1)) return null;          // FSRS will show it first; re-evaluate after that review
  const R_T = retrievability(state, T);                       // if not reviewed before T
  if (R_T >= p.r_exam) return null;                            // r_exam defaults to r_target (0.90)
  const d = R_T >= 0.75 ? 1 : 3;                               // 3 leaves room for a second boost
  return maxDate(today(now), studyDay(T) - d);
}
effectiveDue = min(fsrsDue, min over exams containing the card of examDue)  // never modifies FSRS state
```

- Recomputed on app start, after every sync, at rollover, and when an exam or its scope changes.
- A review triggered by the overlay is a normal FSRS review logged with `reason = exam_boost`; the UI tag is "Reforço pra prova".
- **Target metric:** ≥ 95% of in-scope introduced cards with `R ≥ r_exam` at exam start (spec 04 §10).

### 3.3 Interplay with the planner

When review time is capped by the planner (`R(d) = 0.6 × A(d)`, §11.3), the queue's step-2 cap uses the planner's minutes: `daily_cap = floor(R(d) × 60 / reviewSeconds)`. In-scope cards of `activeExamScopes` come first via `exam_factor`.

### 3.4 `forecastReviewLoad`

```
for each date d in [from, to]:
  simulate each card forward with "rating = Good at effectiveDue" (expected path) using ts-fsrs
  dueCount(d)       = cards whose simulated fsrsDue falls on d
  examBoostCount(d) = cards whose effectiveDue falls on d because of the overlay
  estMinutes(d)     = (dueCount + examBoostCount) × reviewSeconds / 60
reviewSeconds = median duration of the user's last 200 reviews (default 10 s)
```

New cards planned by §4 add their expected first-week reviews (≈ 3 reviews spread over 7 days, spec 07 §8.3.3) to the forecast.

## 4. New-card quota (`newCardQuota`)

One function combines spec 04 §8.4 (content-driven pacing) and spec 07 §8.3 (time-driven, from planned learn minutes). Reconciliation L1 in §22.

```ts
function newCardQuota(u, date): Quota {
  const CAP = 50;
  if (!hasActivePlan(u, date)) return { total: u.settings.new_per_day ?? 20, ... };

  // content-driven floor: introduce every in-scope card before D_e − 1
  let required = 0;
  for (const E of examsWithin(u, date, 30)) {
    const N_E = newCardsInScope(E);            // counted for the earliest exam only, non-excluded, not suspended/hidden
    const days_E = Math.max(1, daysUntil(E, date) - 1);   // allowed days: today … D_e − 2
    required += Math.ceil(N_E / days_E);
  }
  // time-driven: 25% of today's planned learn minutes at ~20 s per new card
  const planned = Math.floor(0.25 * learnMinutes(u, date) * 60 / 20);

  let total = Math.min(CAP, Math.max(planned, required));
  total = protectFutureLoad(u, date, total);   // forecast(next 7 days) must stay ≤ 0.5 × A(day)
  total -= newCardsBlockedByEve(u, date);      // no new cards for a test on D_e − 1 and D_e
                                               // (cards with origin = from_mistake always allowed)
  return { total, required, capped: required > total, bySubject: proRataByLearnMinutes(total) };
}
```

- `capped = true` → the planner shows the "muito conteúdo" warning and cards are introduced by exam date, then weight (spec 04 §8.4).
- Feed micro-lessons that introduce a concept (FED-01.10) count against the same quota.
- Recovery mode (§2.4) forces `total = 0`.

## 5. Mastery

### 5.1 Definition

Mastery is computed at any knowledge-map node by **pooling the evidence of the node and its descendants** (concepts roll up to topics, topics to units).

```
acc_n(t)  = (1 + Σ_e d_e·w_e·s_e) / (2 + Σ_e d_e·w_e)          // Beta(1,1) prior, posterior mean
            d_e = decay_7(t − t_e)                               // half-life 7 days (spec 07 §8.6)
R̄_n(t)    = mean FSRS retrievability at t of introduced, non-suspended cards in n
λ_n       = 0.5 if n has both cards and question evidence; 1 if cards only; 0 if questions only
mastery_n = λ_n·R̄_n + (1 − λ_n)·acc_n            (null when n has neither)
retrievability_n = R̄_n if cards exist, else acc_n if evidence_count ≥ 3 (source "questions"), else null
studied_n = learn unit done ∨ ≥ 5 card reviews ∨ ≥ 3 questions answered in n      (spec 07 §8.6 cov_n)
evidence_count = card reviews + question-type evidence events (raw count)
```

`s_e ∈ [0, 1]` is the evidence score (1 correct, 0 wrong, partial credit per spec 05 §8.4). This makes `mastery_n` exactly the `p_n / cov_n` of spec 07 §8.6, so readiness and mastery never disagree (§13).

### 5.2 Evidence weights

`w_e = type_weight × source_multiplier × confidence_multiplier`.

| Type (spec 05 §8.6) | `type_weight` |
|---|---|
| `true_false` | 0.5 |
| `mcq_single`, `fill_blank`, `numeric`, `matching`, `ordering` | 1.0 |
| `multi_select` | 1.2 |
| `short_answer`, `find_error` | 1.5 |
| `essay_question` | 2.0 |
| `problem` | 2.0 × hint credit (1.0 / 0.75 / 0.5 / 0.25 / 0 for 0/1/2/3 hints / solution viewed — PRA-08.3) |

| Source | `source_multiplier` | Notes |
|---|---|---|
| Quiz, simulado, Caderno retry, session retrieval check (spec 07 §8.4.3), Feed quick question, Trilha question (TRL-01) | 1.0 | |
| Tutor "Me testa" (`tutor_quiz`, TUT-02.5) | 0.5 | `s` = tool `score` |
| Duel / battle answer | 0.75 | Time pressure inflates guessing |
| Ensine o Lucas (INT-02), per key concept at session end | 0.75 | `s` = 1 correct / 0.5 partial / 0 wrong; a `major` taught error on the concept forces `s = 0` |
| Câmera Mágica **assisted** solution (CAM-02.10) | 0 for positive evidence | A wrong "Tentar responder" is negative evidence with weight 1.0; a correct attempt before hint level 3 is normal evidence |
| Self-override of an AI grade ("Eu acho que acertei") | 0.5 | |
| Modo Desespero diagnostic (`diagnostic`, GOL-12.3) | 1.0 | One question per topic; no Caderno de Erros entry |

| Confidence (PRA-05) | `confidence_multiplier` |
|---|---|
| 4 Certeza + correct | 1.2 |
| 1 Chutando + correct | 0.5 |
| Any other combination, or no rating | 1.0 |

Card reviews do **not** add question evidence; they enter mastery only through `R̄_n`.

### 5.3 Storage and incremental update

`mastery` rows (user × node, for every node with evidence) store decayed sums so updates are O(1):

```
on evidence e for node n and each ancestor:
  k = decay_7(t_e − row.updated_at)
  row.sum_w  = row.sum_w  · k + w_e
  row.sum_ws = row.sum_ws · k + w_e·s_e
  row.evidence_count += 1; row.updated_at = t_e
masteryAt(n, t): scale sums by decay_7(t − row.updated_at), compute acc_n, read R̄_n from local card_states
```

The stored `mastery` / `retrievability` columns are a snapshot at `computed_at` (nightly + on evidence) for server consumers (planner, insights); the device always computes live values with `masteryAt`.

### 5.4 Defaults when mastery is `null`

| Consumer | Default | Source |
|---|---|---|
| Planner `m_n` | 0 (not studied → creates `learn(n)`) | spec 07 §8.2 |
| Feed ranking, adaptive selection, Me testa weights | 0.5 | spec 06 §8.2 |
| ENEM topic priority | 0.3 | spec 08 §8.4 |
| Skill tree | state *disponível* (no evidence) | spec 13 §8.6 |

### 5.5 Mastery shift (planner trigger)

The worker compares each in-scope topic's snapshot with its value at the last plan run; `|Δ| ≥ 0.15` on any in-scope topic triggers `mastery_shift` (spec 07 §8.2.6).

## 6. Question selection

### 6.1 Predicted success `p̂` (`predictSuccess`)

```
δ_q = (difficulty_q − 3) / 2                   // difficulty 1–5 → [−1, 1]; empirical when available (§6.5)
m   = masteryAt(concept of q) ?? 0.5            // multi-concept questions: mean over concept_ids
p̂   = σ( β₀ + α · ((2m − 1) − δ_q) )            α = 1.5, β₀ = 1.1
```

At `m = 0.5` and medium difficulty, `p̂ = 0.75`. The pair (α, β₀) is refit per subject by logistic regression on first attempts once the subject has ≥ 200 of them (shrunk toward the defaults with weight 50). `p̂` is used by adaptive selection, duel difficulty and GOL-10 residuals (§11.10). Replaces spec 05 §8.3's provisional `σ(3·(m − δ))` (L3).

### 6.2 Exam urgency (`examUrgency`)

`examUrgency(c) = weight_norm(E) × exp(−days_until(E) / 7)` for the earliest scheduled exam `E` whose scope contains `c`; 0 if none. Used by the Feed (§10) and adaptive selection. (The review queue's overflow priority uses the step function `exam_factor` of §3.1 — deliberately different, see L7.)

### 6.3 Adaptive quiz selection (spec 05 §8.3)

```
candidates = active questions in scope, not answered correctly in the last 7 days
score(q) = 1 − |p̂_q − 0.72|
         + 0.3 · [q unseen]
         + 0.2 · [concept overconfident (§8)]
         + 0.3 · examUrgency(concept_q)
pick greedily by score with constraints:
  ≤ 2 questions per concept; ≥ 3 types in a 10-question quiz when available
  Caderno retries due today go first in "Pontos fracos" and "Hoje" quizzes
```

Preferred band `p̂ ∈ [0.60, 0.85]` (desirable difficulty) is what the first term rewards.

### 6.4 Simulado composition (PRA-03.2, spec 05 §8.7)

1. Topic weights: Prova Provável `ω` (§9.1) when available; otherwise ∝ topic page count, with a floor so each topic gets ≥ 1 question when `count ≥ #topics`.
2. Allocate `count` by **largest remainder** over weights.
3. Within a topic: Bloom mix per PRA-01.3; difficulty spread 20% easy (1–2) / 60% medium (3) / 20% hard (4–5).
4. Prefer unseen; exclude questions seen in the last 7 days; if short, generate more before start (`questions.more`) or reuse oldest-seen.
5. Order: grouped by topic in "Igual à prova" when past tests show that structure; else interleaved.
6. Grade = `round1(score_pct × scale_max)` from `grading_rules` (default 10), shown with decimal comma.

Seed for any sampling: `(user_id, quiz_id)`.

### 6.5 Empirical difficulty (spec 05 §8.10)

After ≥ 20 first attempts on a question (across all users of a shared subject): `empirical_difficulty = 1 − p_correct_first`, mapped to 1–5 by quintiles of the subject's questions; replaces the generator's estimate.

### 6.6 Me testa node selection (spec 03 §8.4)

Phase 1: uniform over non-excluded topics in scope, avoiding nodes asked in the last 2 rounds; difficulty mix ≈ 40% recall / 40% understanding / 20% application.
Phase 2 (TUT-05): `w(node) = (1 − m) + 0.3·[open Caderno entry] + 0.2·[node in nearest exam scope]`, sampled without replacement (seed `(thread_id, round)`).

### 6.7 Duel selection (spec 10 §8.2)

Pool: approved `mcq_single` / `true_false` questions in the chosen topics; exclude questions either player answered in the last 7 days (relax to 3, then 0). Target: average of both players' `m` on the topics; draw ~30% easy / 50% medium / 20% hard **relative to that average** (difficulty from `empirical_difficulty` or `questions.difficulty`, adjusted by class error rate when available). At most `ceil(n / topics) + 1` per topic. Seed `(duel_id)`.

## 7. Caderno de Erros (PRA-04)

### 7.1 Creating entries and suggesting the cause

An entry is created for every wrong answer and for partial answers with score < 0.5 (PRA-04.1). Correct answers rated "Chutando" offer "Salvar no caderno" (cause `didnt_know`).

```ts
function suggestCause(a: AnswerFacts): MistakeCause {     // first match wins (spec 05 §8.5)
  if (a.stemHasQualifier && a.pickedOptionIsTrueStatement) return "misread";   // NÃO / INCORRETA / EXCETO / FALSA
  if (a.pickedOption?.misconceptionConceptId) return "confused";
  const median = a.medianTimeS ?? null;
  if (a.confidence >= 3 && (median ? a.timeS < 0.4 * median : a.timeS < 15)) return "careless";
  if (a.confidence <= 2 || a.skipped || (median && a.timeS > 2 * median)) return "didnt_know";
  return "didnt_know";
}
```

AI-graded answers use the grader's `suggested_cause`. `cause_source ∈ {suggested_kept, user_changed}`.

### 7.2 Re-practice by cause (PRA-04.4)

| Cause | Re-practice |
|---|---|
| `didnt_know` | Concept notes + remediation card + **variant** question |
| `confused` | Contrast drill (`concept_contrasts`, cached per concept pair) + variant question |
| `careless` | Same question in slow mode (3 s pause before "Confirmar resposta") + tip |
| `misread` | Same question with qualifiers highlighted, then one more question with a qualifier |

### 7.3 Retry schedule (PRA-04.5–04.6)

```
retry offsets (study days after the mistake): [1, 3, 7]
on retry correct: correct_days += {studyDay(now)}; if |correct_days| ≥ 2 → resolved
on retry wrong:   schedule restarts at +1 study day; correct_days = {}
```

Retries due today appear in Hoje (GOL-05), the Feed (pool M) and "Refazer erros". Resolving an entry gives XP (§17.1).

## 8. Medidor de Confiança (PRA-05)

```
expected(level, q) = { 1: 1/num_options(q) (0.5 for true/false),  2: 0.55,  3: 0.75,  4: 0.95 }
per bucket (topic, or overall) with n ≥ 10 rated answers:
  accuracy = mean(score)
  gap      = mean(expected) − accuracy
  overconfident  if gap ≥ 0.15
  underconfident if gap ≤ −0.15
Brier = mean((expected − score)²), weekly trend
"bem calibrado" (achievement `calibrated`) = overall |gap| ≤ 0.10 over the last ≥ 50 rated answers
```

Display rules: at most 2 insights at a time, only buckets with `n ≥ 10`. Effects: overconfident topics get `+0.2` in adaptive selection (§6.3) and a `+15%` priority boost in the planner (`π × 1.15`, §11.4).

## 9. Prova Provável models

### 9.1 Teacher topic weights (PRA-09.6, spec 08 §8.2)

Teacher profile statistics are computed per spec 08 §8.1 (question counts toward a topic when `node_match_confidence ≥ 0.6`; `points_share(n)` averaged per test; unprinted points = 1 per question).

```
base_n = est_learn_minutes(n) / Σ_{m ∈ N_e} est_learn_minutes(m)
h_n    = points_share(n) + 0.5 · points_share(siblings of n in the unit, not in N_e) / |siblings|
         + survey evidence: 0.5 per surveyed test, points share 1/k for k topics marked (PRA-09.11)
β      = min(0.7, 0.2 · n_tests)
ω_n    = normalize_{N_e}( base_n^(1−β) · (h_n + ε)^β ),  ε = 0.02
hot topic ("tema quente"): ω_n ≥ 1.5 · base_n ∧ topic in ≥ 50% of past tests
```

Scope always wins (no out-of-scope topic gets weight). **Fixture:** base {0.40, 0.35, 0.25}, h {0.50, 0.10, 0.30}, 2 tests (β 0.4) → ω = {0.468, 0.241, 0.291}; no hot topic.

### 9.2 Blueprint (PRA-09.7, spec 08 §8.3)

1. `Q = round(questions_per_test.mean)`; scale by duration when the exam's duration differs from the profile median by > 30% (min 5).
2. Types by largest remainder over `type_mix`.
3. Topics: systematic sampling over cumulative `ω` with seed `hash(user, exam, regeneration_index)`; ≥ 1 slot for every topic with `ω ≥ 1/Q`; ≤ `ceil(ω_n·Q) + 1` slots per topic.
4. Bloom by largest remainder over `bloom_mix`; difficulty target `difficulty_mean ± 1`.
5. Features: `round(feature_rate × Q)` slots per feature, preferring topics whose past questions had it.
6. Points: distribute `total_points.mode` by `points_by_type`, rounded to 0,5, adjusted to the total.

After generation, near-copies of past questions (normalized token overlap > 0.8) are regenerated once (spec 08 §7.3).

### 9.3 ENEM topic statistics and priority (ENM-08, spec 08 §8.4)

```
universe: official regular-application items from 2009 on; exclude annulled (IN_ITEM_ABAN = 1);
          each item once across booklet colors; PPL/reapplications excluded unless enabled
share_{t,y}     = items_{t,y} / items_{area(t),y}
share_last10    = mean share over the last 10 editions (fewer if unavailable); share_recent5, share_prev5 alike
trend           = up   if share_recent5 ≥ 1.25·share_prev5 ∧ ≥ 2 items in recent 5
                  down if share_recent5 ≤ 0.75·share_prev5 ∧ ≥ 2 items in previous 5
                  flat otherwise
predicted_share = normalize_per_area(0.7·share_recent5 + 0.3·share_last10)
priority_t      = predicted_share_t · (1 − mastery_t) · w_a / max(w)
                  mastery_t = mean mastery of the student's nodes linked to t (null → 0.3)
```

### 9.4 Simulado Provável (ENM-08.4, spec 08 §8.5)

Per area: largest-remainder allocation of 45 × `predicted_share`; fill with unanswered, recent official items, matching a real edition's `b`-quartile mix; foreign-language items (5) follow the chosen language from a single edition; ENEM ordering; redistribute unfillable quotas by share. Deterministic per seed; item ids stored in `quizzes.config` so the TRI estimate is reproducible.

## 10. Feed ranking and interleaving (FED-01, spec 06 §8.2–8.3)

```
pools (scope-filtered): D due cards (incl. exam boost), M Caderno retries due, Q quick questions,
                        G diagrams, L micro-lessons, K você-sabia
priority_i = 0.4·examUrgency_i + 0.3·(1 − m_i) + 0.2·duePressure_i + 0.1·novelty_i − recencyPenalty_i + jitter_i
  m_i            = masteryAt(concept_i) ?? 0.5
  duePressure    = due cards: clamp((now − effectiveDue)/max(1 day, stability), 0, 1) + 0.5·[exam-boosted]
                   M: 1; others: 0
  novelty        = 1 unseen, 0 seen
  recencyPenalty = 1 if shown in the last 24 h (except FED-01.9 re-shows); 0.5 if same concept in the last 3 items
  jitter         ∈ [−0.05, 0.05] from seeded PRNG (user, study day, item id) — tie-breaking only
```

**Round template (5 items)** — each slot takes the best-ranked item from the first non-empty pool in its list:

| Slot | Pools |
|---|---|
| 1 | L or G → K |
| 2 | D → M → Q |
| 3 | Q (same concept as slot 1 if available) → D |
| 4 | D → M → Q |
| 5 | M → K → Q → D |

Constraints: ≥ 3 retrieval items per round; ≤ 2 consecutive items of the same subject when ≥ 2 subjects are in scope; L only within `newCardQuota` (FED-01.10, micro-lesson dwell ≥ 3 s = concept introduced); only D left → review mode with occasional Q.

**Healthy use (spec 06 §8.5):** checkpoint at `session_minutes` (10) or 30 items; "Mais 5 minutos" up to 3 times, then an explicit "Continuar mesmo assim"; daily soft limit 45 min; bedtime card after 23:00; no autoplay, no randomized rewards, no streak-loss pressure.

## 11. Planner (`buildPlan`, GOL-04)

Normative source: spec 07 §8.2–8.3, consolidated here.

### 11.1 Inputs

| Input | Source |
|---|---|
| Scheduled tests `E`: `local_date D_e`, `starts_at`, `kind`, weight `W_e` | `exams` (`status = scheduled`) |
| Scope topics `N_e` (concepts roll up) | `exam_scope_nodes` (or all non-excluded topics, GOL-03.5) |
| Topic weight `ω_{e,n}` (Σ = 1 per test) | ∝ `est_learn_minutes(n)`; Prova Provável `ω` (§9.1) when present |
| `m_n`, `studied_n` | `masteryAt` (§5), null → 0 |
| `ρ_e = required / scale_max` | `requiredGrade` (§14) when grading rules exist; default 0.5 |
| Available minutes `A(d)` | `study_preferences.minutes_by_weekday`, `availability_exceptions` |
| Review forecast | `forecastReviewLoad` (§3.4) |
| Done / pinned items | `plan_items` |
| Pace factor `κ` | EMA (α 0.3) of actual ÷ estimated minutes from `study_sessions`, clamp 0.5–2.0, start 1.0 |

`est_learn_minutes(n) = clamp(Σ_sources pages × f(kind), 10, 90)` with `f(slides) = 1.5`, `f(notes) = 3`, `f(textbook) = 4`, `f(other) = 3` min/page.

### 11.2 Work units

| Unit | Created when | Minutes | Earliest | Deadline |
|---|---|---|---|---|
| `learn(n)` | not studied | `est_learn_minutes(n) × κ` | today | `D_e − 2` |
| `practice(n)` | `m_n < 0.8` | 10 | day after `learn(n)` is placed | `D_e − 1` |
| `practice₂(n)` | after a practice, `m_n < 0.6` | 10 | ≥ 1 day after `practice(n)` | `D_e − 1` |
| `mock(e)` | once per test | `min(45, 3·|N_e| + 15)` | `D_e − 4` | `D_e − 1` (prefer `D_e − 2`) |
| `vespera(e)` | always | 25 | fixed `D_e − 1` | `D_e − 1` |
| `upload_material(n)` | placeholder topic | 5 | today | `D_e − 3` |

Units longer than `max_block_min` (default 30) are split into blocks; a last block shorter than `min_block_min` (default 10) is merged into the previous one. A topic in two tests' scopes gets **one** `learn` unit (earliest deadline); practice units are per test.

### 11.3 Capacity

```
R(d) = min(ceil5(estMinutes(d)), 0.6·A(d))     // reviews reserved first
C(d) = A(d) − R(d)
C(d) = 0.5·C(d) if any test is on day d
pre-place every vespera(e) on D_e − 1 and subtract its minutes
if estMinutes(d) > 0.6·A(d): report plan.review_overflow (FSRS carries it, in-scope cards first)
```

### 11.4 Priority

```
π(u) = W'_e · ω_{e,n} · (1 − m_n) · (1 + ρ_e) · (1.15 if n overconfident (§8) else 1)
W'_e = W_e / max_e W_e
units without a node (mock, vespera): ω = 1, m = readiness_e
```

### 11.5 Feasibility, triage and placement

```
1. Feasibility: for each distinct deadline x (ascending): work(≤ x) ≤ Σ_{d=today..x} C(d)
2. Triage while infeasible — apply the first applicable step to the lowest-π candidate, re-check, repeat:
     a. drop practice₂ units
     b. learn → learn_light (TL;DR + key cards, 50% minutes)
     c. shorten mock to 20 min
     d. drop learn_light of the lowest-π topics ("fora do plano")
     e. never drop vespera or a test's last remaining unit
   record each step in plan_runs.triage → summary "plan.tight"
3. Placement, day by day from today:
     pinned items first
     pass 1 (pacing): for each test by deadline, place available units up to
        q_e(d) = ceil(remaining_e / max(1, deadline_e − d + 1))   (deadline_e = D_e − 1)
     pass 2 (EDF fill): fill the rest of C(d) by earliest deadline
     candidate order (both passes): earliest deadline → higher π → unit kind (learn < practice < practice₂ < mock)
        → knowledge-map order → unit id
     soft constraints (skip a candidate if another fits): ≤ max_subjects_per_day (default 3) subjects;
        ≤ 2 consecutive blocks of one subject; ≤ 1.5·q_e(d) for one test unless needed for feasibility
4. Order in day: reviews → learn → practice → mock → vespera
5. Repair: the aggregate check in step 1 can pass while block sizes still leave a unit unplaced by its deadline.
   Then (a) apply the next triage step and re-place from the earliest affected day; (b) if no step remains,
   place the unit on its deadline day exceeding C(d) by ≤ 15 min and report plan.tight;
   (c) otherwise mark it "fora do plano" (it stays accessible).
```

Tie-breaking among equal `π` in triage: the topic **later** in knowledge-map order is downgraded first (earlier topics tend to be prerequisites).

### 11.6 FSRS contract (planner side)

1. Reserve `R(d)` from `forecastReviewLoad` before placing units.
2. Set the new-card quota from the day's learn minutes via `newCardQuota` (§4).
3. Protect future load (≤ 0.5·A(day) for the next 7 days).
4. No new cards for a test on `D_e − 1` and `D_e` (mistake cards excepted).
5. `activeExamScopes` exposes tests in the next 14 days so the queue puts in-scope cards first.

### 11.7 Replanning

| Trigger | Replan from |
|---|---|
| `nightly` (rollover): unstarted items of the previous day → `skipped`, units return to the pool | today |
| `exam_changed` (added / moved / cancelled / done) | today, including today |
| `scope_changed`, `grade_logged`, `mastery_shift` (§5.5), `material_ready`, `availability_changed` | tomorrow (today if no session started) |
| `manual_edit` (move / pin) | the edited day, around pinned items |

Stability: `done` never changes; pinned never moves; the previous assignment is a tie-breaker preference so a replan moves only what it must. "Reorganizei seu plano" appears only when ≥ 15 minutes of future work changed day.

### 11.8 Several goals

All active `exam_week` goals form one pool. With an active `enem` goal: if an exam-week test is within 14 days, ENEM gets `enem_min_share × A(d)` (default 20%; 0 = "pausar ENEM durante as provas"); otherwise the ENEM generator (§11.9) gets all unit capacity. Reviews are shared and reserved first.

### 11.9 Plano até o ENEM (ENM-07, spec 09 §8.7)

```
weekly capacity W = Σ_week C(d) × ENEM share
fixed units: redação 1/week (2/week in the last 8 weeks): essay 60 + essay_review 15 min; simulados per ENM-07.5 on the longest day
area shares (LC/CH/CN/MT): share_a ∝ max(0.10, w_a · gap_a), gap_a = max(0, t_a − s_a)/100 + 0.2
     (no SISU target: w_a = 1, t_a = s_a + 50)
within an area: topics by priority_t (§9.3); units learn / practice (30 min, ~10 items) / practice₂ (m < 0.6)
phase mix: Base learn 60% / practice 40% · Intensificação 30/70 · Reta Final 0–10 / 90–100
weekly quota = virtual deadline (end of week); unfinished quota rolls over with π × 1.2
Reta Final (ENM-10): window = day1 − 4 weeks; learn only for top-quartile priority topics with m < 0.5,
     never in the last 7 days; full simulados on the 2 Sundays before Day 1; véspera-style unit per area;
     nothing after 21:00 the day before; exam days capacity 0
```

### 11.10 Energy-aware windows (GOL-10)

```
residual(event) = observed (1/0) − expected      expected = R (cards) or p̂ (questions, §6.1)
bucket by local 2-hour window; after ≥ 14 active days and ≥ 300 events:
  window mean residual + 90% CI (normal approximation)
  good window ⇔ CI lower bound > user's overall mean residual; show ≤ 2
placement: demanding units (learn, mock) first into good windows, outside quiet hours; start times snap to 15 min
```

### 11.11 Worked example (unit-test fixture)

Today `d0` = Monday. Bio test Thursday (`d3`), História test Friday (`d4`), both weight 1 (`W' = 1`), no grading rules (`ρ = 0.5`). `A(d) = 70`, forecast reviews 10 min/day → `R = 10`, `C = 60`; test days halved → `C(d3) = C(d4) = 30`. `κ = 1`, `max_block_min = 30`, `max_subjects_per_day = 3`.

- Bio scope: B1, B2 (20 min learn each, `ω = 0.5` each, `m = 0`). Units: learn B1 20, learn B2 20 (deadline d1); practice B1 10, practice B2 10 (d2); mock Bio `min(45, 3·2+15) = 21` (d2); véspera Bio 25 fixed on d2.
- História scope: H1 (20 min, `ω = 1`, `m = 0`). Units: learn H1 20 (d2); practice H1 10 (d3); mock Hist `min(45, 3·1+15) = 18` (d3); véspera Hist 25 fixed on d3.
- Priorities: π(learn/practice B·) = 1 × 0.5 × 1 × 1.5 = 0.75; π(learn/practice H1) = 1.5; π(mock) = 1 × 1 × (1 − readiness 0) × 1.5 = 1.5.

**Capacity after vésperas:** d0 60 · d1 60 · d2 35 · d3 5 · d4 30.

**Feasibility:** ≤ d1: 40 ≤ 120 ✓ · ≤ d2: 40 + 20 + 21 + 20 = 101 ≤ 155 ✓ · ≤ d3: 101 + 28 = 129 ≤ 160 ✓ → no triage.

**Placement:**

| Day | Pass 1 (pacing) | Pass 2 (EDF fill) | Plan (after 10 min of reviews) |
|---|---|---|---|
| d0 | Bio q = ⌈81/3⌉ = 27 → learn B1 (20); learn B2 would exceed 27. Hist q = ⌈48/4⌉ = 12 → learn H1 (20) doesn't fit | 40 left → learn B2 (d1; Bio total 40 ≤ 1.5 × 27); 20 left → learn H1 (d2, π 1.5, kind *learn* beats mock Bio) | learn B1 20 · learn B2 20 · learn H1 20 |
| d1 | Bio q = ⌈41/2⌉ = 21 → mock Bio 21 (π 1.5 beats the practices). Hist q = ⌈28/3⌉ = 10 → practice H1 10 (kind *practice* beats mock Hist) | 29 left → practice B1 10 (Bio total 31 ≤ 31.5); practice B2 would break the 1.5·q cap and mock Hist fits → mock Hist 18 | practice B1 10 · practice H1 10 · mock Bio 21 · mock Hist 18 |
| d2 | Bio q = 10 → practice B2 10 | — | practice B2 10 · véspera Bio 25 |
| d3 | — | — | véspera Hist 25 (Bio test day) |
| d4 | — | — | reviews only (Hist test day) |

All deadlines are met; mock Bio lands on its preferred `D_e − 2`.

New-card quota on d0: `planned = floor(0.25 × 60 × 60 / 20) = 45` → `min(50, max(45, required))`, then future-load protection (§4).

**Triage variant (second fixture).** Same inputs with `A(d) = 60` (`C = 50`, test days 25): capacity after vésperas d0 50 · d1 50 · d2 25 · d3 0 · d4 25; work ≤ d3 = 129 > 125. Step (a) does nothing; step (b) downgrades the lowest-π learn unit — tie between B1 and B2 → the later topic **B2** becomes `learn_light` (10 min) → 119 ≤ 125 ✓. Summary shown: "Plano apertado: B2 vai em versão resumida." The fixture asserts the triage record and that placement completes (using step 5 repair if needed).

### 11.12 Determinism

`buildPlan` is a pure function of its inputs; it uses no randomness. Re-running with the same inputs yields byte-identical `plan_items` (tested). The device preview and the worker run the same code; the worker's run is authoritative.

### 11.13 Modo Desespero (GOL-12)

Eligibility, the plano de ataque triage (`yield = gain / (light_min + 10)`, 70% of capacity to Foco total, the rest to Só o básico), the coverage estimate and the planner overrides are specified in [spec 07 §8.10](../specs/07-goals-semana-de-provas.md#810-modo-desespero-gol-12). They run inside `buildPlan` as a mode flag (`mode: 'normal' | 'desperate'`), so determinism (§11.12) and the triage steps of §11.5 still hold. Fixture: 10 topics, 2 h/day, test in 4 days. It asserts the three groups, the coverage percentage, no item after 23:00 and ≤ 240 planned min/day.

## 12. Session builder (Hoje, GOL-05)

```
input: target T minutes (remaining planned minutes, or 10/20/30 chosen)
1. reviews: min(due — in-scope first, 0.4·T); if T ≤ 10 → reviews only
2. next plan items in order_in_day, truncated to fit T (learn blocks stop at a topic boundary)
3. after each learn block: 3–5 question retrieval check on what was just learned (evidence weight 1.0)
4. close with a 1–2 min recap of cards first seen in this session
5. nothing planned → due reviews → weakest-topic quiz → "Você zerou o dia! 🎉"
```

## 13. Readiness and predicted grade (GOL-08, GOL-11)

### 13.1 Readiness ("se a prova fosse hoje")

```
readiness_e = Σ_{n ∈ N_e} ω_{e,n} · cov_n · mastery_n(now)          cov_n = studied_n (§5.1), mastery null → 0
coveredWeight_e = Σ ω_{e,n} · cov_n
```

Identical to spec 07 §8.6's `p_n` formula (L5).

### 13.2 Predicted grade

```
1. projection to the test date:
   R̄_n^proj = α·r_target + (1 − α)·R̄_n(D_e | no further reviews)
   α = share of due reviews completed on time in the last 14 days (default 0.7)
   readiness_proj_e uses R̄^proj in mastery_n (acc_n decayed to D_e)
2. mapping: ĝ = clamp(a_u + b_u · readiness_proj_e · scale_max, 0, scale_max); start a = 0, b = 1
   after ≥ 3 logged grades with snapshots: least-squares fit of (readiness_proj at D_e − 1, grade on scale)
   shrunk toward the Turma/global fit: θ_u = (n·θ_fit + k·θ_prior)/(n + k), k = 5
3. uncertainty: σ² = σ_model² + σ_sample²
   σ_sample = scale_max · sqrt(Σ_n ω_n² · p_n (1 − p_n)),  p_n = cov_n · mastery_n
   σ_model  = 0.15·scale_max until calibrated, then the residual SD of the shrunk fit
   display the 80% interval ĝ ± 1.28σ, clipped to [0, scale_max], rounded outward to 0,5
4. evidence gate: coveredWeight ≥ 0.5 and ≥ 15 answered questions in scope; else "not_enough"
5. snapshots: readiness_snapshots per active test per day (nightly) and on grade logging
```

## 14. Quanto preciso tirar? (GOL-06)

### 14.1 `grading_rules.formula`

```json
{
  "scale_max": 10,
  "grade_step": 0.1,
  "rounding": { "applies_to": ["term", "year"], "mode": "round_half_up", "step": 0.1 },
  "passing_average": 6.0,
  "terms": { "count": 4, "label": "bimestre", "weights": [1, 1, 1, 1] },
  "term_formula": "weighted_average",
  "recovery": { "type": "replace_if_higher", "applies_to": "term", "cap": null },
  "final_exam": { "enabled": true, "eligible_below": 6.0, "annual_weight": 6, "exam_weight": 4, "passing": 5.0 }
}
```

| Field | Values |
|---|---|
| `term_formula` | `weighted_average` (components with `weight`) · `points_sum` (components with `max_points`; scaled to `scale_max` if Σ max ≠ scale_max) |
| `rounding.mode` / `step` | `none` · `round_half_up` · `ceil` · `floor` / 0.1, 0.25, 0.5, 1 |
| `recovery.type` | `none` · `replace_if_higher` `g' = max(g, r)` · `average_with_original` `g' = (g + r)/2` · `max_of_original_and_average` `g' = max(g, (g + r)/2)` · `replace_capped` `g' = min(cap, max(g, r))`, cap default = passing average |
| `final_exam` | final average = `(annual·annual_weight + exam·exam_weight)/(annual_weight + exam_weight) ≥ passing` |

Presets map to this JSON (spec 07 §8.5.1).

### 14.2 Solver

```ts
function requiredGrade(rules, comps, target): Result {
  const f = (x: number) => evaluate(rules, comps, target.scope, x);  // every pending component in scope = x;
                                                                       // logged grades fixed; rounding per policy
  if (f(0) >= target.value) return { kind: "secured" };
  if (f(rules.scale_max) < target.value) {
    return { kind: "impossible",
             recovery: solveOnGrid(r => evaluateWithRecovery(rules, comps, r), target),   // same binary search
             finalExam: eligibleForFinal(rules, comps) ? solveFinal(rules, comps) : undefined };
  }
  return { kind: "required", value: solveOnGrid(f, target, rules.grade_step) };
}
// f is monotone non-decreasing for every supported policy → binary search over the grade_step grid is exact
```

Targets: `pass_term` (default when the test belongs to a term), `pass_year`, `custom_term(v)`, `custom_year(v)`. Output uses the decimal comma ("5,4").

### 14.3 Fixtures (from spec 07 §8.5.3 — all are unit tests)

| # | Setup | Expected |
|---|---|---|
| A | Term = 0,4·P1 + 0,4·P2 + 0,2·Trab; passing 6,0; P1 5,0; Trab 8,0 | required **6,0** |
| B | Year weights 2-2-3-3; B1 5,5, B2 6,0, B3 7,0 | B4 ≥ **5,4**; nested B4 (P1 4,0, Trab 9,0) → P2 **5,0** |
| C | Term 4,0; `average_with_original`; target 6,0 | recuperação **8,0** (`replace_capped` cap 6,0 → **6,0**) |
| D | Year average 4,0; final weights 6/4; passing 5,0 | final **6,5** |
| E | Points: Prova 6 + Trab 2 + Lista 2; passing 6; Trab 1,5, Lista 2,0 | Prova **2,5 / 6,0** (42%) |
| F | As A with P1 also pending | **5,5** in each |
| G | As A with term rounding half-up step 0,5 | **5,4** |
| H | P1 10, Trab 10 | **secured** |

## 15. ENEM math

### 15.1 TRI estimate (ENM-04.5, spec 09 §8.3) — always labeled "estimativa"

```
3PL:  P_i(θ) = c_i + (1 − c_i) / (1 + exp(−D·a_i·(θ − b_i)))
      parameters converted to the standardized scale per edition (spec 09 §8.1: if median b > 50,
      b_std = (b − 500)/100, a_std = a·100 — unverified, confirm per data dictionary); D per edition (default 1.0)
EAP:  θ_k = 81 points in [−4, 4]; L(θ_k) = Π_i P_i^{u_i}(1 − P_i)^{1−u_i}  (blank = wrong; annulled skipped)
      w_k ∝ L(θ_k)·φ(θ_k);  θ̂ = Σ w_k θ_k;  se = sqrt(Σ w_k (θ_k − θ̂)²)
score = round(500 + 100·θ̂);  80% interval = 500 + 100·(θ̂ ± 1.2816·se)
```

Mini simulados use the same method (wider intervals shown as is). Mixed-edition simulados assume a common scale (working assumption). **Validation target:** on ≥ 10,000 participants per area for ≥ 3 editions from the INEP microdata, correlation ≥ 0.98 and MAE ≤ 15 points; until met, intervals are widened by the observed RMSE.

### 15.2 Coherence

```
erro fácil        : wrong item with P_i(θ̂) ≥ 0.70
acerto improvável : right item with P_i(θ̂) ≤ 0.35
l_0 = Σ [u_i ln P_i + (1 − u_i) ln(1 − P_i)]
E   = Σ [P_i ln P_i + (1 − P_i) ln(1 − P_i)]
Var = Σ P_i(1 − P_i) [ln(P_i/(1 − P_i))]²
l_z = (l_0 − E)/sqrt(Var)  → alta (≥ −1) · média (−1.64 ≤ l_z < −1) · baixa (< −1.64)
```

### 15.3 Meta SISU (ENM-06, spec 09 §8.4)

```
SISU = Σ_k w_k s_k / Σ_k w_k,  k ∈ {LC, CH, CN, MT, RED}   (confirm against the SISU edital)
s_k: mean of the last 2 simulado estimates per area; RED: mean of the last 3 graded essays
T = C + m (margin default 15); G = T·Σw − Σ w_k s_k; G ≤ 0 → "already_above"
h_k = cap_k − s_k (cap 850 objective, 960 RED); g_k = G·(w_k h_k)/Σ(w_j h_j); t_k = s_k + g_k/w_k
clamp t_k to [min_k, cap_k], redistribute; impossible → "too_high"
round up: objective areas to multiples of 5, RED to multiples of 20
```

Fixture (spec 09 §8.4): weights 1/1/2/3/2, estimates 650/700/600/620/760, cut-off 720 → targets LC 725, CH 755, CN 690, MT 705, RED 840.

### 15.4 Time coaching (ENM-04.6)

Day 2 target ≈ (duration − 30 min cartão)/90 ≈ 3,0 min/item; Day 1 ≈ (330 − redação reserve 75 − 30)/90 ≈ 2,5 min/item. Flag items > 2× target ("travou"); accuracy by blocks of 15 positions (fatigue); recommend "duas passadas", never blanks.

### 15.5 Redação totals (ENM-05)

Competência scores ∈ {0, 40, 80, 120, 160, 200}; total = Σ, computed in code. Any zero condition → total 0. Human-rights violation → C5 = 0, others graded. Typed essays: `lines ≈ Σ ceil(chars_per_paragraph / 75)` (unverified heuristic); ≤ 7 lines → zero before any model call; > 30 → warning.

## 16. Mapa da Memória, skill tree and prerequisite detective

### 16.1 Mapa da Memória (MEM-05, spec 04 §8.7)

```
R_card(t)    = ts-fsrs retrievability (introduced, not suspended/hidden)
R_concept(t) = mean R_card; if no introduced cards and evidence_count ≥ 3 → masteryAt(...).retrievability
               ("baseado em questões", dashed outline)
R_topic(t)   = card-count-weighted mean of concept values (concepts without data excluded); no data → "Ainda não estudado"
bands: Forte ≥ 0.90 · Ok 0.75–0.90 · Apagando 0.50–0.75 · Quase esquecido < 0.50 (icon + label, never color alone)
glow = linear map of R to 20–100% opacity/brightness
```

### 16.2 Skill tree states (MOT-02, spec 13 §8.6)

| State | Rule |
|---|---|
| recomendado depois | some prerequisite with mastery < 0.5 |
| disponível | prerequisites ≥ 0.5 (or none) and mastery null or 0 |
| em progresso | 0 < mastery < 0.8 |
| dominado | mastery ≥ 0.8 ∧ retrievability ≥ 0.7 |
| esfriando | mastery ≥ 0.8 ∧ retrievability < 0.7 |

Boss: 10 questions (≤ 4 topics) or 15 (> 4), weighted toward lower-mastery topics; pass ≥ 70%.

### 16.3 Prerequisite detective (LRN-04, spec 02 §8.4)

```
for node N with evidence_count ≥ 5 and mastery_N < 0.5:
  candidates = prerequisites P of N, not excluded, with mastery_P < 0.6 or retrievability_P < 0.7
  pick lowest mastery (tie → lowest retrievability); nudge(N, P) subject to LRN-04.7 rate limits
```

## 17. Motivation (MOT-01)

### 17.1 XP (spec 13 §8.1)

| Event | XP |
|---|---|
| Card reviewed (any rating; none if same card < 10 min ago) | 1 |
| Question answered (first attempt today) / + correct | 2 / +1 |
| Quiz completed (≥ 5 questions) | 5 |
| Simulado completed | 20 + 1 per question |
| Boss defeated (first time / retry) | 50 / 10 |
| Plan item completed | 5 |
| Daily goal met (once per day) | 10 |
| Mistake resolved | 3 |
| Note section read (≥ 30 s and scrolled to end; ≤ 20 XP/day) | 2 |
| Ensine o Lucas finished | 10 + ⌊score/10⌋ |
| Treino de Argumentação finished | 10 |
| Podcast episode ≥ 90% (≤ 3/day) | 5 |
| Duel finished / won | 5 / +5 |
| Battle played / top 3 | 5 / +10, +6, +3 |
| Error report accepted | 5 |
| Focus cycle completed | 3 |

Server-side from synced events, idempotent on `xp_events.client_uuid`. Same XP for every FSRS rating (never reward lying "Fácil").

### 17.2 Levels

`threshold(L) = 50·L·(L + 1)` total XP → L1 100, L2 300, L5 1,500, L10 5,500, L20 21,000; level 0 at 0 XP.

### 17.3 Streaks (spec 13 §8.3, with the 04:00 boundary)

```
counted(d) ⇔ ≥ 5 active minutes ∨ ≥ 10 card reviews ∨ a completed quiz/duel/battle/Lucas/debate
             ∨ an exam of an active goal on d (auto)
auto_rest(d): exam dates of active goals and the day after a goal's last exam
for each day d after last_counted_date (evaluated at rollover or next sync):
  if counted(d): length += 1
  elif rest_day(d) or auto_rest(d): pass
  elif shields > 0: shields −= 1; shield_used(d)
  else: length = 0
every 7 consecutive counted days: shields = min(2, shields + 1)
longest = max(longest, length)
```

Offline conflicts: recompute from `daily_activity` (derived from synced events).

### 17.4 Active minutes (spec 13 §8.2)

A minute is active if the user interacted with a study surface within it and no idle gap exceeded 90 s; podcast playback counts while playing; focus phases per WEL-01.6. Computed on device per session, synced as `study_sessions`, aggregated to `daily_activity.active_minutes`.

### 17.5 League XP (SOC-08, spec 10 §8.5)

`league_xp(day) = min(xp(day) excluding quiet-hours events, 500)`; weekly sum; ties → who reached the total first.

## 18. Social scoring

### 18.1 Duels (SOC-02, spec 10 §8.2)

```
t = server time from served_at to answer receipt − 0.5 s, clamped to [0, T], T = 30 s
points = correct ? 100 + round(50·(1 − t/T)) : 0
answers after deadline_at + 3 s = timeout; total = Σ; tie allowed
```

### 18.2 Battles (SOC-03, spec 10 §8.3)

```
base   = correct ? round(1000·(1 − 0.5·t/T)) : 0         // 500–1000 when correct
streak = correct ? min(50·(answer_streak − 1), 200) : 0   // answer_streak includes this answer
points = base + streak
answers after closes_at + 1 s rejected
```

State machine and `battle.tick` idempotency in spec 10 §8.3. Finished duels/battles are never re-scored after a content fix (spec 10 §8.6).

### 18.3 Class insights (SOC-04, spec 10 §8.4) — enforced in SQL

| Condition (n distinct answerers, w wrong, c = n − w) | Display |
|---|---|
| `n < 5` | nothing |
| `5 ≤ n < 10` or `min(c, w) < 2` | band only: error ≥ 60% "Difícil para a turma"; ≤ 20% "Tranquila para a turma"; else nothing |
| `n ≥ 10` and `min(c, w) ≥ 2` | error rate rounded to 5%, clamped [5%, 95%] |
| Wrong option ("pegadinha") | only if chosen by ≥ 3 people and `n ≥ 10`; rounded to 5% |
| Topic aggregate | mean over the topic's questions with `n ≥ 5`, only if ≥ 3 such questions |

Members with `contribute_insights = false` are excluded from `n`. The TypeScript `classInsightDisplay` mirrors the SQL for tests only.

## 19. Interactive learning scoring

### 19.1 Ensine o Lucas (INT-02, spec 12 §8.6)

```
fixedScore    = 40 · Σ(fixed 1, partially_fixed 0.5, else 0) / #misconceptions
coverageScore = 25 · Σ(correct 1, partial 0.5, wrong 0) / #key_concepts
accuracy      = max(0, 20 − 10·major_errors − 5·minor_errors)
clarity       = 5·[used_example] + 5·[used_analogy] + 5·[checked_understanding]
score = round(fixedScore + coverageScore + accuracy + clarity)       // session ended before turn 4 → "too_short"
```

Lucas evidence enters mastery per §5.2.

### 19.2 Podcast length (INT-01, spec 12 §8.2)

`target_words = 150 × minutes`; shares: hook 3% · agenda 3% · topics 78% (weighted by exam scope weight, or `1 − mastery` for "Revisão pra prova"; ≤ 6 topics per 10 min) · recap 8% · quick-fire 6% · outro 2%. Validation ±15% (ai-pipeline `podcast.script`).

### 19.3 Argumentation (INT-03)

Six criteria 0–4 per round and overall (spec 12 §8.7); session score shown per criterion, no aggregate grade. ENEM mapping is informative only.

## 20. Wellbeing

### 20.1 Burnout heuristics (WEL-03, spec 13 §8.10)

| Heuristic | Trigger |
|---|---|
| Long session | ≥ 50 min continuous active study without a ≥ 5 min break (outside focus timers); repeat once at 90 min |
| Daily load | active minutes today > max(2 × daily goal, 180) |
| Late night | ≥ 10 min active study 23:00–05:00 before a school day (Sun–Thu); exam eve threshold 22:30; once per night |
| Performance drop | in-session accuracy of the last 20 items ≥ 25 points below the first 20, or median response time up ≥ 50% |
| Overload trend | ≥ 6 of the last 7 days with active minutes > 1.5 × goal ∧ 7-day accuracy trending down → offer "Rebalancear plano" (replan with lighter days) |
| Check-in low | two consecutive lowest check-in answers → supportive message + help card |

Nudges never interrupt a timed activity (duel, battle, simulado); caps per WEL-03.2.

### 20.2 Quiet hours and notification caps

Defaults 22:00–07:00 (≥ 8 h; under-18s can't disable — mobile-app §5.3); study reminders never after 20:00; ≤ 3 unrequested pushes per day (spec 00 §8.4, spec 13 §8.7). Not learning logic, but the planner and reminder scheduler read the same `quietHours(user)` helper.

## 21. Tests that pin these algorithms

| Area | Tests ([testing-strategy](testing-strategy.md)) |
|---|---|
| FSRS wrapper, replay, undo, cross-device dedup, clock clamp, exam overlay, queue order, recovery mode | §3.1 — property tests (replay of shuffled logs = same state), fixtures from spec 04 §8.5 |
| New-card quota | §3.4 — combined formula cases incl. véspera blocking and future-load protection |
| Mastery | §3.4 — decay math, evidence weights per source, null defaults, incremental update = batch recompute |
| Planner | §3.3 — the §11.11 fixture (exact `plan_items`), triage order, replanning stability, determinism (same input → identical output) |
| Quanto preciso tirar? | §3.2 — fixtures A–H, monotonicity property test |
| Readiness / predicted grade | §3.4 — gate, interval rounding, shrinkage |
| Prova Provável | §3.4 — §9.1 fixture, blueprint determinism per seed |
| TRI / coherence / SISU | §3.4 — TRI against a hand-computed 5-item example and the INEP validation script (spec 09 §11); SISU fixture |
| Feed | §3.4 — round template fill with empty pools, constraints, seeded jitter |
| XP / streaks / levels, duel / battle scoring | §3.4 — tables above as fixtures; streak shields and auto-rest days |
| Class insights | §4 — SQL RPC thresholds (pgTAP), TS mirror equality |
| Lucas score, calibration | §3.4 — rubric arithmetic, Brier/gap thresholds |

## 22. Reconciliations

| # | Conflict | Resolution | Spec text to update |
|---|---|---|---|
| L1 | New-card limit: spec 04 §8.4 (content-driven `required`, cap 60, last 2 days review-only via `days_E = days_until − 2`) vs spec 07 §8.3 (time-driven `quota(d)`, cap 50, no new cards on `D_e − 1` and `D_e`). | One `newCardQuota` (§4): `min(50, max(planned, required))`, future-load protection, no new cards for a test on `D_e − 1`/`D_e`; `days_E = days_until − 1` so pacing aligns with the `learn` deadline `D_e − 2`. | 04 §8.4 (cap 50, `days_until − 1`), 07 §8.3.2 (reference §4). |
| L2 | Day boundary: spec 13 §8.3 streaks use 03:00; MEM-02.13 and spec 07 §8.1 use 04:00. | One `day_rollover_hour = 04:00` for everything (§0.2). | 13 §8.3 and its open question. |
| L3 | Adaptive selection `p̂ = σ(3·(m − δ))` (spec 05 §8.3, provisional). | Recentered logistic `σ(1.1 + 1.5·((2m − 1) − δ))` with per-subject refit (§6.1). | 05 §8.3. |
| L4 | Unknown mastery defaults differ (0.5 Feed, 0.3 ENEM, 0 skill tree / planner). | `masteryAt` returns `null`; each consumer keeps its documented default (§5.4). | none (documented here). |
| L5 | Spec 07 §8.6 says readiness's `p_n` "may later be replaced" by the mastery table. | Mastery is defined so that `mastery_n = p_n / cov_n` exactly; readiness = Σ ω·cov·mastery (§13.1). | 07 §8.6 note. |
| L6 | Evidence weights for duel/battle, Lucas, Feed questions, retrieval checks and assisted camera solutions were unspecified ("defined in learning-engine"). | §5.2 table. | 03 §6 (tutor_quiz 0.5 confirmed), 11 CAM-02.10 (confirmed), 12 (Lucas 0.75). |
| L7 | Two exam-urgency functions: step `exam_factor` (spec 04 §8.3) and `exp(−days/7)` (spec 06 §8.2, reused by spec 05 §8.3). | Both kept, with distinct names: queue overflow vs Feed/selection ranking (§3.1, §6.2). Different purposes, not a contradiction. | none. |
| L8 | Readiness accuracy half-life (7 days, spec 07) vs mastery decay (unspecified). | One half-life, 7 days, for question evidence everywhere (§5.1). | none. |
| L9 | Spec 04 §8.6 assumes a Node binding of the official FSRS optimizer. | Kept, marked unverified, with a Python sidecar fallback (§2.5). | 04 §8.6 note. |
| L10 | Overconfidence effect in the planner ("priority boost", PRA-05.5) had no number. | `π × 1.15` (§11.4) and `+0.2` in selection (§6.3). | 05 PRA-05.5, 07 §8.2.4. |
| L11 | Planner block sizes (`max_block_min`, `min_block_min`) and `max_subjects_per_day` had no defaults. | 30 / 10 / 3 (§11.2, §11.5); settings in `study_preferences`. | 07 §8.2.2, §8.2.5. |
| L12 | Spec 07 §8.2.5 has no rule for a unit that can't be placed by its deadline even though the aggregate feasibility check passed (block granularity), and no full candidate ordering. | Explicit candidate order (deadline → π → unit kind → map order → id) and a repair step (§11.5 step 5). | 07 §8.2.5. |

## 23. Trilha (TRL-01)

Pure functions in `packages/shared/src/learning/trail.ts`, tested in `test/learning/trail.test.ts` ([spec 14 §8](../specs/14-trilha.md#8-rules-and-algorithms)).

| Function | Rule |
|---|---|
| `normalizeTrailPlan` | Model order kept; unknown/repeated ids dropped, missing appended in outline order; stable topological repair (concept edges across topics lifted to topics); cycles broken at the earliest item. |
| `conceptOutcome` | cleared: 2 correct learning-phase answers · shaky: 5 answers without that · open otherwise. |
| `nextTrailMove` | Resume a served step → first open concept: lesson → re-teach the last miss → next practice question → chapter test (`checkpointBlueprint`, 4–10, weak first) → pass at 0.7, else re-teach up to 3 missed concepts and run a new round. |
| `trailNeeds` | Blocking need first, then one lookahead (next lesson · test on the last concept · next chapter's first lesson during the test); at most 2. |
| `chapterFraction`, `trailProgress` | Each concept one unit, the test one more; path = (finished chapters + fraction) / chapters. |

Evidence: every Trilha answer is a `mcq_single` event with source multiplier 1.0 (§5.2, source `trail`).

