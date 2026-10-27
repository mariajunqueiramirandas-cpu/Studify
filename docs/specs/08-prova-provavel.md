# 08 — Prova Provável

| Status | Phase(s) | Features |
|---|---|---|
| Draft v1 | 2 (PRA-09) · 4 (ENM-08) | PRA-09, ENM-08 |

Related: [PRD](../product/PRD.md) · [01 — Ingestion](01-ingestion-knowledge-map.md) (document upload, knowledge map) · [05 — Practice & exams](05-practice-exams.md) (quiz engine, simulados) · [07 — Goals & Semana de Provas](07-goals-semana-de-provas.md) (scope, planner weights) · [09 — ENEM mode](09-enem-mode.md) (question bank, TRI simulado, redação, Atualidades) · [Learning engine](../engineering/learning-engine.md)

---

## 1. Summary

**Prova Provável** looks at what an examiner asked before to estimate *what is most likely to be asked next* — and turns that into study priorities and a realistic practice test.

| | School (PRA-09) | ENEM (ENM-08) |
|---|---|---|
| **Evidence** | The teacher's past tests that students upload (`documents.kind = past_test`) | The official ENEM question bank ([ENM-02](09-enem-mode.md)) and the list of past redação themes |
| **Profile** | *Perfil do professor*: structure, question types, points, difficulty, recurring patterns, topic emphasis | Topic and skill (H1–H30) frequency per area across editions, with trends |
| **Prediction** | Topic weights inside the upcoming test's scope | Topic priorities for the ENEM plan |
| **Output** | A full **Prova Provável**: new questions in the teacher's style + "por que essas questões?" | **Temas em alta**, a TRI-scorable **Simulado Provável** built from official items, and **temas prováveis de redação** for practice |
| **Feeds** | Planner topic weights `ω` and readiness ([07 §8.2](07-goals-semana-de-provas.md#82-planner-buildplan)) | Plano até o ENEM priorities ([09 ENM-07](09-enem-mode.md)) |

Both are **predictions, never guarantees**, and the UI always says so.

## 2. Goals and non-goals

**Goals**
- With 2+ past tests from the same teacher, the student gets topic priorities and a practice test that "feels like" that teacher's tests.
- Predictions are explainable: every hot topic and every question in a Prova Provável shows its evidence.
- ENEM topic statistics are reproducible from the bank (pure SQL/code, no model needed) and back-tested.
- Classmates benefit from each other's uploads (shared subjects).

**Non-goals**
- Promising what "vai cair". No percentages framed as "chance de cair" for a single school test.
- Using a test that has not happened yet (leaked/upcoming tests) — see §9 integrity rules.
- Reproducing a teacher's past questions verbatim *inside* the Prova Provável (they are available separately, as their own material, in "Provas antigas").
- Predicting the actual ENEM redação theme. We generate plausible practice themes; we do not track rumors or "leaks".

## 3. User stories

| # | As a… | I want to… | So that… |
|---|---|---|---|
| US-1 | student | upload photos of last year's tests from the same teacher (from a veterano) | Studify learns how this teacher asks |
| US-2 | student | see which topics this teacher loves to ask | I prioritize them |
| US-3 | student | take a test in the same style and length as the real one | there are no surprises on the day |
| US-4 | student | know why each predicted question is there | I trust (and question) the prediction |
| US-5 | student | practice the actual old questions with answers | I train on real material |
| US-6 | ENEM student | see which topics fall most in my areas and which are rising | I study what pays off |
| US-7 | ENEM student | take a simulado shaped like the most likely ENEM | I train for the probable exam, with a TRI estimate |
| US-8 | ENEM student | practice redação with themes that make sense for this year | I'm not surprised by the theme |

## 4. Functional requirements

### PRA-09 — Prova Provável (school)

- **PRA-09.1 — Upload.** In a subject, the student uploads past tests (PDF or photos; multiple photos = one document) via "Adicionar prova antiga". Metadata asked: teacher name (free text, with autocomplete from the subject), year, term (optional), "é uma prova de antes desta etapa?" (required yes). Uses the ingestion pipeline ([01](01-ingestion-knowledge-map.md)) with `documents.kind = past_test`.
- **PRA-09.2 — Extraction.** Each past test is parsed by `pastTest.extract` (§7.1) into `questions` with `origin = past_test`: number, statement, type (multiple choice / true-false / open / calculation / matching / fill-in), alternatives, answer key when printed, points (when printed), page location, format features (contextualized, has figure/graph/table, requires calculation, multi-part), Bloom level, estimated difficulty, and topic mapping to the subject's knowledge map with confidence. Handwritten student answers and teacher correction marks on photographed graded tests are **ignored**.
- **PRA-09.3 — Provas antigas.** Extracted questions are practicable immediately as quizzes ("Provas antigas" section), using the printed answer key when available; otherwise the solution is generated during extraction and labeled "Resolução gerada pelo Studify — confira com o professor". Each question links to the page of the original document (📄 chip).
- **PRA-09.4 — Teacher profile.** When a subject has ≥ 1 extracted past test for a teacher, the worker builds a `teacher_profiles` row (§8.1) for (subject, teacher). If an upcoming test has no `teacher_name`, the subject-level aggregate profile (all teachers) is used and labeled as such.
- **PRA-09.5 — Confidence label.** Every profile and prediction shows a confidence level: **baixa** (1 past test or < 50% of past points mapped to the current material), **média** (2–3 tests), **alta** (≥ 4 tests and ≥ 70% of points mapped).
- **PRA-09.6 — Predicted weights.** For an upcoming test with a confirmed scope ([07 GOL-03](07-goals-semana-de-provas.md)), compute predicted topic weights `ω` (§8.2). They replace the default weights in the planner and readiness for that test (`exams` linked through `topic_predictions`), and the dashboard shows "Temas quentes" with evidence ("caiu em 3 das 4 provas antigas", "vale em média 2,5 pontos").
- **PRA-09.7 — Prova Provável.** "Gerar Prova Provável" creates a quiz (`quizzes.kind = predicted_test`) that mirrors the profile: number of questions, type mix, points, difficulty and Bloom mix, presence of contextualized/figure/calculation questions; topics sampled by `ω` (§8.3). Questions are **new** (not copies), grounded in the subject's material with `source_pages`, and each carries a short `rationale`. It can be taken timed (duration = profile median or the exam's `duration_min`) through the quiz engine ([05 PRA-03](05-practice-exams.md)); results feed mastery, the Caderno de Erros and readiness like any simulado.
- **PRA-09.8 — Regeneration.** Profiles and predictions are recomputed when a past test is added/removed, the scope changes, or the knowledge map changes materially. A Prova Provável can be regenerated (new questions) up to 3 times per test per user (PLT-04 budget).
- **PRA-09.9 — Sharing.** In a Turma-shared subject ([10](10-turma-social.md)), past tests, extracted questions and teacher profiles are shared with all members; predicted weights are computed per test scope (the same for classmates with the same scope); each student's generated Prova Provável and attempts are personal. The uploader can delete a past test, which removes it from future profiles.
- **PRA-09.10 — Honesty.** Every Prova Provável screen shows: "Provável, não garantido. Baseado em {n} provas antigas do(a) {professor}." The words "vai cair" never appear.
- **PRA-09.11 — Post-test feedback.** After the real test (GOL-02.4), an optional one-tap survey "O que caiu?" (multi-select of scope topics) is offered; answers are used only for accuracy metrics (§10) and, in a shared subject, to strengthen the teacher profile (counted like a past test with topic-level evidence only, weight 0.5).

### ENM-08 — Prova Provável ENEM

- **ENM-08.1 — Topic statistics.** From the official bank ([09 ENM-02](09-enem-mode.md)), compute per edition and per area: item counts per `enem_topics` node (area → subject → topic), per skill (H1–H30) and per competência de área; annulled items excluded (§8.4). Statistics are global (not per user), recomputed when a new edition is imported.
- **ENM-08.2 — Trends.** For each topic: share over the last 10 editions, share in the last 5 editions vs the 5 before, and a label **em alta / estável / em baixa** (§8.4).
- **ENM-08.3 — Personal priorities.** For the student: `priority_t = predicted_share_t × (1 − mastery_t) × area_weight_a` (area weights from Meta SISU, [09 ENM-06](09-enem-mode.md)); the top topics per area feed Plano até o ENEM (ENM-07). Students see "Mais cobrados", "Em alta" and "Pra você agora" lists per area, each item with its evidence ("apareceu em 9 das últimas 10 edições").
- **ENM-08.4 — Simulado Provável.** A simulado built **only from official items** whose topic distribution follows `predicted_share` (§8.5), so it is TRI-scorable by [ENM-04](09-enem-mode.md). Available per area (45 items) and per day (90 items, + redação on Dia 1). Items the student has already answered are avoided when possible.
- **ENM-08.5 — Past redação themes.** A reference list of all past redação themes with year (seeded from INEP publications, `enem_redacao_themes`), each one practicable in Correção de Redação ([ENM-05](09-enem-mode.md)).
- **ENM-08.6 — Temas prováveis de redação.** A monthly-refreshed ranked list of 8–12 **practice themes** (`essay_themes.source = predicted`), generated by `enem.themes.predict` (§7.4) from past-theme patterns and the last 12 months of Atualidades digests ([ENM-09](09-enem-mode.md)). Each theme has: title in ENEM style, the social axis, a 2–3 sentence rationale, connections to recent events (with source links from the Atualidades digest), suggested repertório directions, and a full practice prompt with motivating texts (§7.4 rules). Labeled "Tema de treino — ninguém sabe o tema real".
- **ENM-08.7 — Explainer.** "Como calculamos" explains, in plain PT-BR, frequency, trends and why predictions are uncertain; it links to the back-test result (§10).
- **ENM-08.8 — No rumor tracking.** Web content claiming leaked or "confirmed" themes is never used or shown.

## 5. UX and screens

| Screen | Content |
|---|---|
| **Provas antigas** (subject tab) | List of past tests (teacher, year, term, n questions), upload button, "Praticar" per test or "Misturar todas" |
| **Perfil do professor** | Confidence badge; structure card (n questões, tipos, pontos); "Temas quentes" with evidence; patterns ("sempre tem uma questão com gráfico"); difficulty bar |
| **Detalhe da prova → Prova Provável** | Generate / take / regenerate; result screen with per-question rationale and topic links |
| **ENEM → Prova Provável** | Tabs per area: Mais cobrados · Em alta · Pra você agora; "Simulado Provável" CTA; "Temas de redação" section |
| **Temas prováveis de redação** | Ranked cards → theme detail (rationale, connections, repertório directions) → "Escrever redação" |

### Key PT-BR strings

| Key | String |
|---|---|
| `pp.title` | Prova Provável |
| `pp.disclaimer` | Provável, não garantido. Baseado em {n} provas antigas do(a) {teacher}. |
| `pp.upload` | Adicionar prova antiga |
| `pp.upload.integrity` | Essa prova já aconteceu? Só vale prova de etapas anteriores. |
| `pp.need_more` | Com mais provas antigas a previsão fica melhor. Peça pros veteranos! |
| `pp.confidence.low` | Confiança baixa |
| `pp.confidence.mid` | Confiança média |
| `pp.confidence.high` | Confiança alta |
| `pp.hot` | Temas quentes |
| `pp.evidence.count` | Caiu em {k} de {n} provas antigas |
| `pp.evidence.points` | Vale em média {points} pontos |
| `pp.generate` | Gerar Prova Provável |
| `pp.regenerate` | Gerar outra versão |
| `pp.why` | Por que essa questão? |
| `pp.generated_solution` | Resolução gerada pelo Studify — confira com o professor. |
| `pp.survey` | O que caiu na prova? Isso ajuda a melhorar a previsão. |
| `ppe.most` | Mais cobrados |
| `ppe.rising` | Em alta |
| `ppe.for_you` | Pra você agora |
| `ppe.evidence` | Apareceu em {k} das últimas {n} edições |
| `ppe.simulado` | Fazer Simulado Provável |
| `ppe.themes` | Temas prováveis de redação |
| `ppe.theme.disclaimer` | Tema de treino — ninguém sabe o tema real do ENEM. |

## 6. Data

### 6.1 Entities used

`documents` (`kind = past_test`), `document_pages`, `questions` (`origin = past_test` / `enem_official`), `knowledge_nodes`, `exams`, `exam_scope_nodes` ([07](07-goals-semana-de-provas.md)), `quizzes`, `quiz_attempts`, `attempt_answers`, `mastery`, `subjects`, `class_groups`, `ai_jobs`, `ai_usage`; ENEM: `enem_items`, `enem_topics`, `enem_skills`, `essay_themes`, `sisu_targets` (defined in [09](09-enem-mode.md)).

### 6.2 New entities / fields

| Table | Column | Type | Purpose |
|---|---|---|---|
| `documents` | `teacher_name` | text, nullable | Teacher of a past test |
| `documents` | `exam_year`, `exam_term` | int, nullable | When the past test was applied |
| `documents` | `integrity_confirmed` | bool | Uploader confirmed the test already happened (PRA-09.1) |
| `questions` | `source_document_id` | uuid, nullable | The past test it was extracted from |
| `questions` | `position` | int, nullable | Question number in the original test |
| `questions` | `points` | numeric, nullable | Printed value |
| `questions` | `format_features` | text[] | `contextualized`, `figure`, `graph`, `table`, `calculation`, `multi_part` |
| `questions` | `answer_key_source` | enum `printed` / `generated` / `official` | PRA-09.3 |
| `questions` | `node_match_confidence` | numeric, nullable | For past-test mapping |
| `questions` | `rationale` | text, nullable | "Por que essa questão?" (predicted tests) |
| `quizzes` | `kind` value `predicted_test` | enum value | PRA-09.7 (ENM-08.4 uses `enem_simulado` with `config.predicted = true`) |
| `teacher_profiles` (new) | `id`, `subject_id`, `teacher_key` (normalized name; null = subject aggregate), `teacher_display`, `source_document_ids` (uuid[]), `n_tests`, `profile` (JSON, §8.1), `confidence` (`low` / `mid` / `high`), `computed_at`, `version` | | PRA-09.4 |
| `topic_predictions` (new) | `id`, `target_type` (`exam` / `enem_goal`), `target_id`, `node_id` (school) or `enem_topic_id` (ENEM), `weight` (0–1), `base_weight`, `evidence` (JSON), `teacher_profile_id` (nullable), `computed_at` | | PRA-09.6, ENM-08.3 |
| `exam_outcome_topics` (new) | `exam_id`, `user_id`, `node_id` | | "O que caiu?" survey (PRA-09.11) |
| `enem_topic_stats` (new, derived) | `enem_topic_id`, `area`, `edition_year`, `item_count`, `area_item_count`, `share` | | ENM-08.1 |
| `enem_topic_trends` (new, derived) | `enem_topic_id`, `share_last10`, `share_recent5`, `share_prev5`, `trend` (`up` / `flat` / `down`), `predicted_share`, `computed_at` | | ENM-08.2 |
| `enem_redacao_themes` (new) | `edition_year`, `application` (`regular` / `ppl` / other), `theme`, `source_url` | | ENM-08.5 |
| `essay_themes` | `source` value `predicted`; `rationale`, `axis`, `connections` (JSON with digest item ids + URLs), `valid_until` | | ENM-08.6 (table defined in [09](09-enem-mode.md)) |

## 7. AI behavior

All calls: model `claude-opus-5-5`, PLT-04 budget check, `ai_usage` row with feature ID (`PRA-09` / `ENM-08`), `stop_reason` handled (incl. `refusal`, with `fallbacks: "default"`), Zod validation with one retry.

### 7.1 `pastTest.extract` (PRA-09.2)

| | |
|---|---|
| **Runs** | Worker job per document after ingestion; standard API (the student is waiting to see results); if ≥ 4 past tests are uploaded together, they go through the **Batch API** |
| **Inputs** | The past test as a native PDF document block (or image blocks for photos); the subject's knowledge-map outline (ids, titles, summaries), **prompt-cached** across documents of the same subject |
| **Effort** | `medium` (`high` for photographed/handwritten documents) |
| **Output** | Structured output: `{ test: { title?, teacher_guess?, year_guess?, total_points?, duration_guess? }, questions: [{ position, page, type, statement_md, alternatives?: [{label, text_md}], answer?: {value, source: "printed" | "generated"}, solution_md?, points?, format_features[], bloom, difficulty: 1-5, node_matches: [{node_id, confidence}] }] }` |
| **Rules** | Transcribe faithfully (LaTeX for math); ignore handwriting that is a student's answer or a correction mark; `answer.source = generated` whenever no key is printed; never invent node ids (validated against the outline) |
| **Citations** | `page` per question → stored as `source_pages` on the question |

### 7.2 `teacherProfile.build` (PRA-09.4)

Mostly deterministic statistics (§8.1). One AI call adds the qualitative part:

| | |
|---|---|
| **Inputs** | The extracted questions of all the teacher's past tests (JSON, no images), the computed statistics |
| **Effort** | `medium` |
| **Output** | Structured output: `{ patterns: [{ text, evidence_question_ids[] }], style_notes: string, typical_command_verbs: string[] }` — e.g. "Sempre pede para justificar a alternativa escolhida" |
| **Rule** | Every pattern must cite ≥ 2 questions from ≥ 2 different tests (validated); otherwise it is dropped |

### 7.3 `predictedTest.generate` (PRA-09.7)

| | |
|---|---|
| **Runs** | Worker job on demand ("Gerar Prova Provável"); target < 3 min; progress via `ai_jobs` |
| **Inputs** | The question **blueprint** from §8.3 (slots with topic, type, points, Bloom, difficulty, format features); the teacher profile (structure, patterns, style notes) and 3–6 anonymized example questions from past tests as style references; the PDF slices of the source pages of the sampled topics (document blocks, **prompt-cached** per subject) |
| **Effort** | `high` |
| **Output** | Structured output: `{ questions: [{ slot_id, statement_md, alternatives?, answer, solution_md, explanation_md, source_pages: [{document_id, page_start, page_end}], rationale }] }` |
| **Rules** | Fill every slot; new questions (not paraphrases of the examples); `source_pages` must be within the provided slices (validated, mapped back to original page numbers); after generation, a cheap deterministic **similarity check** (normalized token overlap) against the teacher's past questions rejects near-copies (> 0.8 overlap) and regenerates those slots once |

### 7.4 `enem.themes.predict` (ENM-08.6)

| | |
|---|---|
| **Runs** | Worker job, monthly (1st Monday) and on demand by an admin; global, shared by all users |
| **Inputs** | `enem_redacao_themes` (all past themes with years); the last 12 months of Atualidades digest items ([09 ENM-09](09-enem-mode.md)) with their source URLs; the list of currently active predicted themes (to keep continuity) |
| **Effort** | `high` |
| **Output** | Structured output: `{ themes: [{ title, axis, rationale, connections: [{digest_item_id, why}], repertorio_directions: string[], prompt: { instruction, motivating_texts: [{ kind: "summary" | "data", text, source_url, source_name, published_at }] } }] }` |
| **Rules** | 8–12 themes across ≥ 5 different social axes; no theme equal or near-equal to a past ENEM theme; titles follow ENEM's style (problem framed as a challenge/path, Brazilian context) without copying any past title; motivating texts are **short summaries written by Studify** of the cited digest sources or data points taken from them — no long verbatim quotes — each with source link and date; no political party advocacy; age-appropriate; never mention rumors or "temas vazados" |
| **Why no web search here** | Fresh facts come from the Atualidades digest, which already did the web research with sources; this call only synthesizes. |

### 7.5 What is not AI

Frequency counts, trends, predicted shares, predicted weights `ω`, blueprint sampling and Simulado Provável item selection are deterministic code (testable, free, reproducible).

## 8. Rules and algorithms

### 8.1 Teacher profile (`teacher_profiles.profile`)

Computed from the extracted questions of the teacher's past tests `T` (n = |T|):

```json
{
  "n_tests": 4,
  "questions_per_test": { "mean": 10.5, "sd": 1.3, "min": 9, "max": 12 },
  "total_points": { "mode": 10 },
  "type_mix": { "multiple_choice": 0.55, "open": 0.35, "calculation": 0.10 },
  "points_by_type": { "multiple_choice": 0.5, "open": 1.5 },
  "bloom_mix": { "remember": 0.2, "understand": 0.35, "apply": 0.35, "analyze": 0.1 },
  "difficulty_mean": 2.8,
  "feature_rates": { "contextualized": 0.6, "figure": 0.3, "graph": 0.25, "calculation": 0.4, "multi_part": 0.15 },
  "duration_min": { "median": 50 },
  "topic_history": [{ "node_id": "…", "tests_with_topic": 3, "points_share": 0.18 }],
  "unmapped_points_share": 0.22,
  "patterns": [{ "text": "…", "evidence_question_ids": ["…"] }]
}
```

- A question counts toward a topic when `node_match_confidence ≥ 0.6`; below that it counts as unmapped. Concept matches roll up to their topic.
- `points_share(n)` = Σ points of questions mapped to `n` ÷ Σ points of all questions, averaged per test (each test weighs the same). When points are not printed, each question counts 1.

### 8.2 Predicted topic weights (PRA-09.6)

For an upcoming test `e` with scope topics `N_e`:

```
base_n  = est_learn_minutes(n) / Σ_{m∈N_e} est_learn_minutes(m)       // default planner weight
h_n     = points_share(n) + 0.5 × points_share(siblings of n in the same unit, not in N_e) / |siblings|
β       = min(0.7, 0.2 × n_tests)                                       // evidence strength
ω_n     = normalize_{N_e}( base_n^(1−β) × (h_n + ε)^β ),   ε = 0.02
```

- Topics outside the scope are never added (scope wins).
- `ε` keeps every in-scope topic > 0.
- **Hot topic** ("tema quente"): `ω_n ≥ 1.5 × base_n` **and** the topic appeared in ≥ 50% of past tests.
- Survey evidence (PRA-09.11) enters `h_n` with weight 0.5 per surveyed test (topic presence only, points share = 1/k for k topics marked).

**Worked example (fixture).** Scope = {Genética (base 0.40), Evolução (0.35), Ecologia (0.25)}; 2 past tests (β = 0.4); `h` = {0.50, 0.10, 0.30}.
`Genética: 0.40^0.6 × 0.52^0.4 = 0.577 × 0.770 = 0.444`
`Evolução: 0.35^0.6 × 0.12^0.4 = 0.533 × 0.428 = 0.228`
`Ecologia: 0.25^0.6 × 0.32^0.4 = 0.435 × 0.634 = 0.276`
Sum 0.948 → **ω = {0.468, 0.241, 0.291}** (no out-of-scope siblings in this fixture). Genética is not "quente" (0.468 < 1.5 × 0.40 = 0.60).

### 8.3 Prova Provável blueprint (PRA-09.7)

1. `Q = round(questions_per_test.mean)`; if the test has `duration_min` set and it differs from the profile median by > 30%, scale `Q` proportionally (min 5).
2. **Types:** allocate `Q` across `type_mix` by largest remainder.
3. **Topics:** systematic sampling over the cumulative `ω` with a seed = hash(user, exam, regeneration index) → deterministic per version; guarantee ≥ 1 slot for every topic with `ω ≥ 1/Q`; at most `ceil(ω_n × Q) + 1` slots per topic.
4. **Bloom and difficulty:** assign to slots by largest remainder from `bloom_mix`, difficulty target = `difficulty_mean` ± 1.
5. **Features:** mark `round(feature_rate × Q)` slots with each feature, preferring topics where past questions had that feature.
6. **Points:** if `total_points.mode` exists, distribute it using `points_by_type`, rounded to 0,5 and adjusted to the total.

### 8.4 ENEM topic statistics and trends (ENM-08.1–08.2)

- **Universe:** official items of the **regular application** of each edition from 2009 onward (the 4 × 45 format); reapplications/PPL are stored but excluded from statistics unless an admin enables them; annulled/abandoned items (`IN_ITEM_ABAN` = 1 in the microdata, see [09](09-enem-mode.md)) are excluded; each item counted once even though it appears in several booklet colors.
- `share_{t,y} = items_{t,y} / items_{area(t),y}`.
- `share_last10` = mean of `share_{t,y}` over the last 10 imported editions (fewer if not available); `share_recent5`, `share_prev5` analogously.
- **Trend:** `up` if `share_recent5 ≥ 1.25 × share_prev5` and the topic has ≥ 2 items in the recent 5 editions; `down` if `share_recent5 ≤ 0.75 × share_prev5` and ≥ 2 items in the previous 5; else `flat`.
- **Predicted share:** `predicted_share_t = 0.7 × share_recent5 + 0.3 × share_last10`, renormalized per area.
- **Personal priority** (ENM-08.3): `priority_t = predicted_share_t × (1 − mastery_t) × w_a / max(w)`, where `mastery_t` is the student's mastery mapped to the ENEM topic (via `knowledge_nodes ↔ enem_topics` links, [09](09-enem-mode.md)); topics with no evidence for the student get `mastery_t = 0.3` (unknown, not zero, to avoid pure frequency ranking).

### 8.5 Simulado Provável item selection (ENM-08.4)

1. For each area, target counts per topic = largest-remainder allocation of 45 × `predicted_share`.
2. Fill each topic's quota with official items: prefer items the student has not answered; prefer recent editions; respect a difficulty mix close to a real edition (quartiles of the `b` parameter of a real edition used as the target); for Linguagens, the 5 foreign-language items follow the student's chosen language (Inglês/Espanhol) and come from a single edition's set.
3. Order items as ENEM orders them (by area and booklet sequence convention), not by topic.
4. If a topic's quota cannot be filled, redistribute to the next topics by share.
5. Selection is deterministic per seed; the chosen item ids are stored in `quizzes.config` so the TRI estimate ([09 §8.3](09-enem-mode.md)) is reproducible.

## 9. Edge cases and errors

| Case | Behavior |
|---|---|
| Uploader answers "não" to "essa prova já aconteceu?" | Upload refused: "Só dá pra usar provas que já aconteceram." |
| Past test dated in the **current term** of an active goal for the same subject and teacher | Excluded from profiles by default, shown as practice only, with a note; can be included only if it is a *different* test of the same term (e.g. P1 when predicting P2) — the uploader confirms. |
| Only **1** past test | Profile and weights shown with "confiança baixa"; Prova Provável allowed. |
| Past test from **another teacher** or another school | Separate profile (teacher key); not mixed into the teacher's profile; subject aggregate shown only when no teacher-specific profile exists. |
| Most past points **unmapped** (old syllabus, topics not in the material) | Confidence capped at baixa; card "Muitas questões antigas são de assuntos fora do seu material" with the unmapped topic names (from extraction) as hints for missing uploads. |
| Photo is a **graded test** with answers and marks | Marks ignored; if the extraction cannot separate printed text from handwriting in a question, that question is flagged `needs_review` and excluded from profiles until the uploader fixes or deletes it. |
| No answer key printed | Generated solution, labeled (PRA-09.3); students can flag wrong solutions (TRU-02). |
| Blurry/unreadable pages | Those questions are skipped with a "não consegui ler a página {p}" note; re-upload option. |
| Teacher name typed differently ("Prof. Ana", "Ana Paula") | Normalized `teacher_key` (lowercase, no titles/accents); suggestion "É a mesma pessoa que 'Ana Paula'?" before merging. |
| Scope changes after generating a Prova Provável | Existing attempt keeps its questions; "Sua Prova Provável é do conteúdo antigo — gerar de novo?" |
| Regeneration limit reached | "Você já gerou 3 versões. Que tal revisar os erros da última?" |
| ENEM topic with very few items | Trend `flat` (thresholds need ≥ 2 items); shown in "Mais cobrados" only if `share_last10` is in the area's top 20. |
| A new ENEM edition is imported | Stats, trends and predicted shares recomputed; the change is logged in `enem_topic_trends.computed_at`; active ENEM plans replan (`material_ready` trigger). |
| Atualidades digest unavailable for months | Theme prediction still runs from past-theme patterns; connections list empty; rationale says so. |

## 10. Metrics

| Metric | Definition | Target |
|---|---|---|
| Extraction accuracy | Questions correctly captured (statement, type, alternatives, key) on the 5-test eval set | ≥ 90% |
| Mapping precision | Past questions mapped to the right topic (`confidence ≥ 0.6`), eval set | ≥ 85% |
| Top-3 hot topic hit rate | Share of surveyed real tests (PRA-09.11) where ≥ 2 of the predicted top-3 topics fell | track; ≥ 60% with confiança alta |
| Weight error | Mean absolute error between `ω` and surveyed topic presence (normalized) vs. error of `base` weights | `ω` better than `base` |
| Near-copy rate | Generated predicted questions rejected by the similarity check | < 10% |
| Prova Provável usage | Tests with ≥ 1 predicted test taken ÷ tests with a profile | ≥ 40% |
| ENEM back-test | For each edition Y in the last 5, predict shares from editions < Y and compare to actual shares: Spearman ρ per area | report; must beat the "uniform over topics" baseline |
| Theme engagement | Essays written on predicted themes ÷ all ENEM essays | track |

## 11. Acceptance criteria

- [ ] Uploading 3 photographed past tests of one teacher produces extracted questions, a teacher profile with confidence "média", and practicable "Provas antigas" with page links.
- [ ] A handwritten student answer on a graded test never appears in an extracted question (eval set of 2 graded tests).
- [ ] `ω` computation matches the worked example in §8.2 (unit test) and never assigns weight to out-of-scope topics.
- [ ] Planner and readiness use `ω` for tests with a prediction (integration test with [07](07-goals-semana-de-provas.md) `buildPlan`).
- [ ] A Prova Provável has `Q` within ±1 of the profile mean, the same type mix (±1 question per type), and every question has `source_pages` inside its slices and a rationale.
- [ ] No generated question exceeds 0.8 token overlap with any past question of that teacher.
- [ ] The disclaimer is visible on every Prova Provável screen; the string "vai cair" does not appear in the app's strings or AI outputs (lint + output filter test).
- [ ] Integrity: a past test upload without the "já aconteceu" confirmation is rejected by the API, not only the UI.
- [ ] ENEM statistics are reproducible: recomputing from the same bank yields identical `enem_topic_stats` and `enem_topic_trends`.
- [ ] The ENEM back-test report (§10) is generated by a script and checked into `docs/engineering/` results before Phase 4 exit.
- [ ] A Simulado Provável uses only official non-annulled items, respects the foreign-language choice, and stores item ids for reproducible TRI scoring.
- [ ] Predicted redação themes: 8–12 themes, ≥ 5 axes, none equal to a past theme (string + fuzzy check), every motivating text has a source URL and date.

## 12. Open questions

1. **Teacher names:** store real teacher names, or replace them with an alias ("Prof. A") on shared subjects to avoid exposing adults' names in a student app?
2. **"O que caiu?" survey:** OK to ask after every test (one tap, optional)? It is the only way to measure prediction quality for school tests.
3. **Same-term tests:** allow using P1 of the current term to predict P2 (proposed: yes, with confirmation), or only previous terms?
4. **ENEM reapplications/PPL:** include them in statistics (more data) or only regular applications (proposed)?
5. **Theme refresh cadence:** monthly (proposed) or weekly closer to the exam?
