# Studify — Open decisions for the owner

Every decision below was raised while writing the specs. Each has a **default**: if you don't decide, the docs and the build follow the default. Decisions marked 🔴 **block** the step in the "Needed by" column.

Answer them in any order. When you decide, the answer gets recorded here and the linked docs are updated.

## Before inviting classmates (legal and safety)

| # | Decision | Default | Needed by | Where |
|---|---|---|---|---|
| D-01 🔴 | **Who is the legal controller** of the users' data? The owner may be a minor; an adult (parent/guardian or a school partner) should take this role and sign vendor agreements. | An adult guardian of the owner | Inviting classmates | [security-privacy.md](../engineering/security-privacy.md) SP-18 |
| D-02 🔴 | **Talk to a lawyer** before inviting classmates? (LGPD Art. 14, ECA Digital, international transfer to the Claude API in the US.) | Yes, one review of the privacy notice and the guardian rules | Inviting classmates | [security-privacy.md](../engineering/security-privacy.md) §2 |
| D-03 | **Minimum age**: 12 (legal floor without parental consent) or 14? | 12 | Phase 0 | [00-platform](../specs/00-platform.md) PLT-02.3, SP-01 |
| D-04 | **Guardian link for under-16 users**: mandatory before Turma features, or only recommended? | Mandatory before Turma social features | Phase 2 | SP-03, [00-platform](../specs/00-platform.md) PLT-02.4 |
| D-05 🔴 | **Domain** for HTTPS invite links, the install landing page and the privacy notice. | None; one is needed because WhatsApp doesn't make `studify://` links clickable | Phase 2 (Turma invites); privacy page before inviting | [api.md §10](../engineering/api.md#10-deep-links-and-app-links), [mobile-app.md](../engineering/mobile-app.md) |
| D-06 | **Image hash-matching service** (child-safety detection) before photos can be shared to a Turma. | Photos stay private until one is integrated | Phase 3 | SP-12 |

## Infrastructure and cost

| # | Decision | Default | Needed by | Where |
|---|---|---|---|---|
| D-07 🔴 | **Anthropic API key and spending caps** per environment (dev/staging/prod). | Owner creates the keys and sets a global monthly cap | Phase 0 | [ai-pipeline.md](../engineering/ai-pipeline.md), PLT-04 |
| D-08 | **AI limits**: per-user daily, per-Turma monthly, global monthly. | Set after Phase 0 measures cost per page | End of Phase 0 | PLT-04, [security-privacy.md §7](../engineering/security-privacy.md#7-rate-limiting-and-ai-budgets-plt-04) |
| D-09 | **Cheaper model for bulk work** (card/question generation, short-answer grading, moderation)? | No: every task uses `claude-opus-5-5`; revisit with Phase 0 cost data | End of Phase 0 | [ADR 0003](../engineering/adr/0003-claude-api-opus-default.md), [ai-pipeline.md](../engineering/ai-pipeline.md) |
| D-10 | **Where to host the job worker** (candidates in ADR 0005). | Pick during Phase 0 setup | Phase 0 | [ADR 0005](../engineering/adr/0005-job-worker-pg-boss.md) |
| D-11 | **Reference phone** for performance budgets. | The cheapest Android phone in the class | Phase 0 | [mobile-app.md](../engineering/mobile-app.md) |
| D-12 | **Text-to-speech provider** for the podcast (Google, Azure, Amazon Polly, ElevenLabs), and podcast length/cost caps. | Decide in Phase 3 after a voice-quality test in PT-BR | Phase 3 | [12-interactive-learning](../specs/12-interactive-learning.md) |
| D-13 | **Code execution** for math: let Claude run code to check answers when generating or solving math problems? | Camera solves: on for quantitative problems (spec 11). Problem generation: test it in Phase 3 (spec 05) | Phase 3 | [05-practice-exams](../specs/05-practice-exams.md), [11-camera-magica](../specs/11-camera-magica.md) |

## Product defaults (Phases 1–2)

| # | Decision | Default | Where |
|---|---|---|---|
| D-14 | Send one or two **real examples of your school's grading rules** (how the bimestre average and recuperação work). | Presets for common 0–10 rules | [07-goals-semana-de-provas](../specs/07-goals-semana-de-provas.md) |
| D-15 | **Default study time** per day for the planner. | 60 min on weekdays, 90 min on weekends, editable | [07](../specs/07-goals-semana-de-provas.md) |
| D-16 | Ask **"O que caiu?"** after each test, to learn the teacher's style for Prova Provável? | Yes, optional and skippable | [08-prova-provavel](../specs/08-prova-provavel.md) |
| D-17 | Store **real teacher names** or aliases? | Free text, shown only to the user (and the Turma for shared subjects) | [08](../specs/08-prova-provavel.md) |
| D-18 | **Medidor de Confiança** step on by default? | On, with a one-tap "pular" | [05](../specs/05-practice-exams.md) |
| D-19 | **Answer options** per multiple-choice question. | 5 (A–E) | [05](../specs/05-practice-exams.md) |
| D-20 | Support the **somatória** question format (common in the South) in Phase 1? | Phase 2 | [05](../specs/05-practice-exams.md) |
| D-21 | **Widget rating buttons**: 2 (Errei / Lembrei) or 4. | 2 | [04-flashcards-memory](../specs/04-flashcards-memory.md) |
| D-22 | **Feed limits**: 10-minute sessions and a 45-minute daily soft limit? A lighter Feed (cards + questions only) in Phase 1? | Yes to the limits; Feed stays in Phase 2 | [06-feed-de-estudos](../specs/06-feed-de-estudos.md) |
| D-23 | May **"Você sabia?"** Feed items use facts from outside your material (labeled)? | No | [06](../specs/06-feed-de-estudos.md) |
| D-24 | Convert **DOCX/PPTX** to PDF on the server (teachers often send .pptx)? | Yes, Phase 1 | [01-ingestion-knowledge-map](../specs/01-ingestion-knowledge-map.md) |
| D-25 | **Reuse generated content across Turmas** when the exact same file is uploaded? | No (each Turma's content stays separate) | [01](../specs/01-ingestion-knowledge-map.md) |
| D-26 | Long **tutor threads**: server-side compaction, or start a new linked thread at a cap? | Cap and continue | [03-tutor](../specs/03-tutor.md) |
| D-27 | **Quiet hours**: may students move them? | Yes, but under-18s keep at least 8 hours | [00-platform](../specs/00-platform.md), [13-motivation-wellbeing](../specs/13-motivation-wellbeing.md) |
| D-46 | **Exam-day load**: halve study capacity on test days, or leave the day free after the test? | Halve capacity | [07](../specs/07-goals-semana-de-provas.md) |
| D-48 | **Modo Desespero** generates Foco total topics on the standard API (faster, no batch discount) when material is still processing. OK to spend more for speed here? | Yes | [07](../specs/07-goals-semana-de-provas.md) GOL-12.8 |
| D-47 | Does anyone in the class use a phone **without Google Play services** (some Huawei models)? The document scanner depends on it. | Assume everyone has Play services; a basic camera fallback exists | [11-camera-magica](../specs/11-camera-magica.md) |

## Turma (Phase 2)

| # | Decision | Default | Where |
|---|---|---|---|
| D-28 | Does **joining a Turma** need the organizer's approval? | Organizer approves each request, with an "Aprovar todos" button (`approval` policy) | [10-turma-social](../specs/10-turma-social.md) |
| D-29 | May **members upload** to shared subjects? | Yes | [10](../specs/10-turma-social.md) |
| D-30 | Who handles **reports escalated** past the Turma moderators? | The owner (`app_admin`) | [10](../specs/10-turma-social.md), SP-09 |
| D-31 | May **AI-confirmed error fixes** apply automatically when no moderator acts? | No: the item stays hidden "em revisão" until a moderator acts (alternative: auto-apply high-confidence fixes after 72 h) | [10](../specs/10-turma-social.md) |
| D-32 | May quizzes be **shared outside the Turma**? Questions come from the teacher's material. | As in SOC-09.2: outsiders can take a question snapshot but never open the material (alternative: Turma members only) | [10](../specs/10-turma-social.md) |
| D-44 | Who can **host a live battle**? | Any member; owner/moderators can restrict it (SOC-03.1) | [10](../specs/10-turma-social.md) |
| D-45 | Who can publish the shared **"Regras da escola"** grading template? | Turma owner and moderators | [07](../specs/07-goals-semana-de-provas.md) GOL-06.7 |

## Phase 3 and later

| # | Decision | Default | Where |
|---|---|---|---|
| D-33 | **Voice tutor**: allow "Me testa" by voice? (It would be close to the removed Prova Oral.) | No | [03-tutor](../specs/03-tutor.md) |
| D-34 | Ensine o Lucas: keep the name **Lucas**? Allow fully voice sessions? | Keep the name; typed only | [12-interactive-learning](../specs/12-interactive-learning.md) |
| D-35 | **Mascot**: Capi the capybara? | Proposal; decide with the visual identity | [13](../specs/13-motivation-wellbeing.md), [ux-guidelines](../design/ux-guidelines.md) |
| D-36 | **App blocking** during focus needs two special Android permissions. Worth it? | Build the focus timer first; decide on blocking after user feedback | [13](../specs/13-motivation-wellbeing.md) |
| D-37 | Keep the optional **weekly mood check-in**? | Yes, stored only on the device | [13](../specs/13-motivation-wellbeing.md) |
| D-38 | How long to keep **unsaved camera photos**. | 30 days (alternative: 7 days for stronger privacy) | [11-camera-magica](../specs/11-camera-magica.md) |

## ENEM mode (Phase 4)

| # | Decision | Default | Where |
|---|---|---|---|
| D-39 | **Licensing** of past ENEM questions inside the app (INEP publishes them; third-party texts inside questions may be copyrighted). | Proceed for the private class app with attribution to INEP; legal check before any wider release | [09-enem-mode](../specs/09-enem-mode.md) |
| D-40 | **SISU data source** for cut-off scores and weights. | Official MEC data where available; manual entry as fallback | [09](../specs/09-enem-mode.md) |
| D-41 | **Atualidades** news source allowlist. | Major Brazilian outlets and official sources; list to approve | [09](../specs/09-enem-mode.md) |
| D-42 | **Redação**: grade each essay twice (like ENEM's two graders) and cap essays per week? | Single correction by default, dual correction as a per-essay option; 3 corrections per user per week | [09](../specs/09-enem-mode.md) |
| D-43 | Include **PPL / reaplicação** exams in the question bank? | In the bank for practice (hidden by default), excluded from topic statistics | [09](../specs/09-enem-mode.md) |

## Decided during the docs pass

These came up as conflicts between docs and were settled with the safest default. They're recorded here so you can overrule them.

| Decision | Resolution | Where |
|---|---|---|
| Claude Files API retention | File ids are ephemeral: deleted when the job that uploaded them finishes, and after 48 h at most. Synchronous calls send PDF slices directly. | [ai-pipeline.md §4.2](../engineering/ai-pipeline.md#42-files-api) |
| Study "day" boundary | 04:00–04:00 local time for plans, streaks and study limits; AI limits reset at midnight. | [architecture.md §5](../engineering/architecture.md#5-cross-cutting-conventions) |
| "Não cai na prova" | Per student, not per subject (classmates in a shared Turma can differ). | [data-model.md](../engineering/data-model.md) |
| Batch requests and refusal fallbacks | The Batch API doesn't accept fallbacks; refused batch items are re-run on the standard API. | [ai-pipeline.md](../engineering/ai-pipeline.md) |
| Invite codes | 8 characters (Crockford Base32 without 0, O, 1, I, L), rate-limited; owner invites expire in 14 days. | [00-platform](../specs/00-platform.md), [10](../specs/10-turma-social.md) |
