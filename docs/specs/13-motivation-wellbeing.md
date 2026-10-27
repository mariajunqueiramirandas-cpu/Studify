# 13 — Motivation & wellbeing

| Status | Phase(s) | Features |
|---|---|---|
| Draft v1 | 1 (WEL-04 baseline) · 2 (MOT-01) · 3 (WEL-04 read-aloud & voice input) · 5 (MOT-02–04, WEL-01–03) | MOT-01 … MOT-04, WEL-01 … WEL-04 |

Related: [PRD](../product/PRD.md) · [07 — Goals & Semana de Provas](07-goals-semana-de-provas.md) · [10 — Turma (leagues, rooms)](10-turma-social.md) · [04 — Flashcards](04-flashcards-memory.md) · [Mobile app](../engineering/mobile-app.md) · [Security & privacy](../engineering/security-privacy.md) · [UX guidelines](../design/ux-guidelines.md)

---

## 1. Summary

Motivation features make showing up easy and rewarding; wellbeing features make sure that showing up never turns into anxiety, exhaustion or late nights.

| Feature | One line |
|---|---|
| **MOT-01** | Daily goal in active minutes, streaks with **Escudos** (freezes) and rest days, XP and levels, private achievements. |
| **MOT-02** | Skill tree: each subject as a game map; topics light up as mastered; each unit ends in a "boss" mock test. |
| **MOT-03** | **Capi**, a capybara mascot that grows with you — and is never sad when you're away. |
| **MOT-04** | Retrospectiva: a story-style recap after each exam week and at the end of the semester/year. |
| **WEL-01** | Focus timer (Pomodoro) with an ongoing notification. |
| **WEL-02** | Optional blocking of distracting apps during focus. |
| **WEL-03** | Burnout guard: breaks, overload, late-night and sleep nudges — gentle and rare. |
| **WEL-04** | Accessibility: font scaling, contrast, legible fonts, reduced motion, read-aloud, voice input. |

**Ethics stance (users are mostly minors).** No dark patterns: no loss-aversion pressure ("você vai perder sua sequência!"), no notifications at night, no guilt-tripping mascot, no rewards for studying late, no pay-to-keep-streaks, no infinite-scroll engagement metrics as goals. Rewards favor **consistency and recall**, not raw time.

## 2. Goals and non-goals

**Goals**
- Help students study a little every day during exam periods (spacing beats cramming).
- Make progress visible and satisfying.
- Protect sleep, rest and mental health; make help resources easy to find.
- Make the app usable for students with low vision, dyslexia, motor or reading difficulties.

**Non-goals**
- Parental controls or monitoring of the student by others.
- Monetized streak repair or cosmetic shops.
- Public profiles or global leaderboards (Turma leagues live in [SOC-08](10-turma-social.md), opt-in).
- Medical/psychological assessment. The app points to professional resources; it doesn't diagnose.

## 3. User stories

| # | As a student, I want to… | So that… |
|---|---|---|
| U1 | set a realistic daily goal | I don't feel I'm always behind |
| U2 | keep my streak when I skip Sunday on purpose | resting isn't punished |
| U3 | see my XP and level go up | I feel progress |
| U4 | see a map of my subject light up | I know what I've mastered and what's left |
| U5 | fight the "boss" of a unit | reviewing a unit feels like a challenge |
| U6 | have a cute mascot that celebrates with me | the app feels friendly |
| U7 | see a recap after exam week | I'm proud of what I did |
| U8 | start a 25-min focus session from a plan item | I actually study instead of scrolling |
| U9 | block Instagram and TikTok during focus | I stop opening them by reflex |
| U10 | be reminded to take a break or sleep | I don't burn out before the test |
| U11 | read with a bigger, more legible font and have notes read aloud | studying is less tiring |

## 4. Functional requirements

### MOT-01 — Daily goal, streaks, XP, achievements (Phase 2)

| ID | Requirement |
|---|---|
| MOT-01.1 | **Meta do dia** in **active study minutes** (§8.2): options 10 / 20 (default) / 30 / 45 / 60. During an active Semana de Provas, the Hoje screen shows the planner's suggestion for the day (GOL-04) and offers "Usar a meta do plano". |
| MOT-01.2 | **Sequência** (streak): consecutive **study days** (§8.3). A study day needs only a small minimum (not the full daily goal). |
| MOT-01.3 | **Escudos** (streak freezes): earned automatically (1 per 7 counted days, hold max 2), applied automatically on a missed day. |
| MOT-01.4 | **Dia de descanso:** the user can choose one recurring weekday as a rest day; it neither breaks nor extends the streak. Exam days and the day after a goal's last exam are automatic rest days. |
| MOT-01.5 | **Streak loss is gentle:** no notification about losing it; on the next open, a single message shows the record and encourages restarting (§5.2). Longest streak is always kept. |
| MOT-01.6 | **XP** is earned per activity (§8.1); **levels** follow §8.4. XP rewards recall and consistency (reviews, questions, completed plan items) more than passive time. |
| MOT-01.7 | Anti-farming rules (§8.1): XP only for meaningful events (e.g. a card reviewed within 10 min again gives no XP), first attempt per question per day. |
| MOT-01.8 | **Conquistas** (achievements): catalog in §8.5; private by default; the user may opt in to show up to 3 on their Turma member card. |
| MOT-01.9 | **Reminders:** at most 1 study reminder per day, sent at the user's usual study time (median start time of the last 14 days; default 17:00), **never after 20:00 and never during quiet hours** (§8.7). Wording is an invitation, never a threat (§5.2). Can be turned off. |
| MOT-01.10 | Celebrations (goal met, level up, achievement) use short animations that respect reduced-motion settings (WEL-04.4). |

### MOT-02 — Skill tree (Phase 5)

| ID | Requirement |
|---|---|
| MOT-02.1 | Each subject has a **Mapa** view generated from the knowledge map: units = regions, topics = nodes, prerequisite edges as paths. Layout is deterministic per subject (stable between visits). |
| MOT-02.2 | Node states (§8.6): *recomendado depois* (soft-locked), *disponível*, *em progresso*, *dominado*, *esfriando* (mastered but fading). **Nothing is ever hard-locked** — students must be able to study whatever is on the test. |
| MOT-02.3 | The active exam's scope (GOL-03) is highlighted on the map ("Cai na prova"). |
| MOT-02.4 | Each unit ends in a **Chefão** (boss): a 10–15 question mock (PRA-03) mixing all the unit's topics, with a "vida" bar that drops as you answer correctly. Pass at ≥ 70%: unit badge + XP (§8.1). Can be attempted any time; retries get different questions. |
| MOT-02.5 | Tapping a node opens the topic (notes, cards, quiz, Ensine o Lucas). |

### MOT-03 — Mascote Capi (Phase 5)

| ID | Requirement |
|---|---|
| MOT-03.1 | **Capi** is a capybara mascot. It grows in stages tied to the user's level (§8.4): *filhote* (L1–4), *jovem* (L5–14), *adulta* (L15–29), *sábia* (L30+). |
| MOT-03.2 | Cosmetic accessories (hats, glasses, scarves in subject colors) unlock via achievements and levels; the user equips them. Cosmetic only, never purchasable. |
| MOT-03.3 | Moods: *comemorando* (goal met), *focada* (focus session), *curiosa* (default), *descansando* (user away), *sonolenta* (late night, as a gentle sleep cue). **Capi is never sad, sick, hungry or "dying"** because the user didn't study. |
| MOT-03.4 | Appears on the Hoje header, the home-screen widget (MEM-04), results screens and some empty states. Can be hidden in settings. |

### MOT-04 — Retrospectiva (Phase 5)

| ID | Requirement |
|---|---|
| MOT-04.1 | Generated automatically: after a goal's last exam (Semana de Provas recap), at the end of each semester (default end of June and end of November, editable), and a yearly one in December. |
| MOT-04.2 | 6–8 story-format cards (9:16), swipeable: total active hours, cards reviewed, questions answered, best subject, most improved topic, longest streak, best Lucas score, duels won, calibration improvement (PRA-05), a closing card. |
| MOT-04.3 | Each card can be shared as an image (rendered on device). Shared images never include classmates' names, and include grades only if the user toggles "Mostrar notas". |
| MOT-04.4 | One playful AI-written title per Retrospectiva ("Seu bimestre em uma frase"), optional (§7). |

### WEL-01 — Focus timer (Phase 5)

| ID | Requirement |
|---|---|
| WEL-01.1 | **Modo foco** presets 25/5, 50/10 and custom (focus 10–90 min, break 3–30 min, 1–6 cycles, long break after 4 cycles). |
| WEL-01.2 | Start from a plan item (GOL-04), a subject, the Hoje screen, or a Sala de estudo (SOC-05 shared timer). The session is linked to what's being studied. |
| WEL-01.3 | Ongoing notification with countdown, pause/skip/stop actions, visible on the lock screen; end-of-phase sound + vibration (respecting silent mode). Implementation constraints in §8.8. |
| WEL-01.4 | Optional **Não perturbe** during focus (Android Do Not Disturb via notification policy access, granted by the user). |
| WEL-01.5 | **Soft focus (no permissions):** if the user switches to another app while the screen is on during a focus phase, Studify notes an *interrupção*; on return, a light message ("Voltou! Bora continuar?"). Screen off/locked is not an interruption (studying from paper is fine). |
| WEL-01.6 | Focus minutes count as active minutes for the daily goal only while the user interacts with Studify or the screen is off during a focus phase with the session started from a plan item (studying off-screen). |
| WEL-01.7 | Break screens suggest a non-screen activity ("Levanta, bebe água, alonga") and never push more studying during the break. |

### WEL-02 — Block distracting apps (Phase 5)

| ID | Requirement |
|---|---|
| WEL-02.1 | Opt-in **Bloquear apps durante o foco**. The user picks apps from a list of installed launcher apps. |
| WEL-02.2 | Approach: UsageStats foreground detection + overlay (§8.9, option B). No AccessibilityService, no device admin. |
| WEL-02.3 | When a blocked app opens during a focus phase, a full-screen Studify overlay appears: "Foco até {hh:mm}. Bora voltar?" with **Voltar pro Studify**, **Desbloquear por 5 min** (requires a 10-s press-and-hold) and **Encerrar foco**. |
| WEL-02.4 | Never blockable: phone/dialer, SMS, emergency, clock/alarm, settings, Studify. Max session 3 h. Blocking ends automatically when the focus phase ends (breaks are unblocked). |
| WEL-02.5 | The list of installed apps and any usage data stay **on device**; nothing about other apps is uploaded. Only aggregate counts (number of blocked attempts per session) may sync. |
| WEL-02.6 | Permission onboarding explains exactly why each permission is needed and how to revoke it; the feature degrades to soft focus (WEL-01.5) if permissions are missing or revoked. |

### WEL-03 — Burnout guard (Phase 5)

| ID | Requirement |
|---|---|
| WEL-03.1 | Heuristics in §8.10: long continuous sessions, very high daily load, late-night study on school nights, performance drop within a session, multi-day overload trend. |
| WEL-03.2 | Nudges are suggestions, never blocks. Max 1 nudge per heuristic per day and 2 per day overall. Each nudge has **Agora não** and a setting to turn wellbeing nudges off (crisis resources stay available). |
| WEL-03.3 | Overload trend nudge offers to **rebalance the plan** (GOL-04 replan with lighter days). |
| WEL-03.4 | Optional weekly check-in "Como você tá com os estudos?" (5 emoji). Stored **on device only**. Two consecutive lowest answers show a supportive message and the help card. |
| WEL-03.5 | **Help card** ("Precisa conversar?"): CVV — 188 (free, 24 h) and cvv.org.br chat; SAMU 192 for emergencies. Always reachable from Perfil → Bem-estar. |
| WEL-03.6 | **Distress in conversations** (tutor, Lucas, Argumentação, ✋): a shared system-prompt rule makes the model respond supportively, step out of any persona, and append the marker `[[APOIO]]`, which the app replaces with the help card (§8.11). |
| WEL-03.7 | **Quiet hours** (§8.7) apply to every push notification in the app. |

### WEL-04 — Accessibility (Phase 1 baseline, Phase 3 read-aloud & voice)

| ID | Requirement |
|---|---|
| WEL-04.1 | **Font scaling:** respects Android font size up to 200% without clipped or overlapping text; layouts reflow (no fixed-height text containers). |
| WEL-04.2 | **Contrast:** text and essential UI meet WCAG 2.2 AA (4.5:1 text, 3:1 UI components) in light and dark themes; an optional **Alto contraste** theme. |
| WEL-04.3 | **Not by color alone:** correct/incorrect, mastery and streak states always have icon + text (✓ / ✗, labels). |
| WEL-04.4 | **Reduced motion:** honor Android "Remover animações"; in-app toggle **Reduzir animações** disables confetti, parallax and auto-advancing transitions. |
| WEL-04.5 | **Leitura facilitada:** font choice (default system font, **Atkinson Hyperlegible**, **OpenDyslexic**) and adjustable letter spacing (0 / +5% / +10%) and line height (1.4 / 1.6 / 1.8). |
| WEL-04.6 | **Screen reader:** every interactive element has a PT-BR TalkBack label and role; flashcard flip, quiz options and timers announce state changes; math is announced via its spoken form (WEL-04.8). |
| WEL-04.7 | **Touch targets** ≥ 48 × 48 dp; no gesture-only actions (every swipe has a button alternative, incl. the Feed). |
| WEL-04.8 | **Read-aloud (Phase 3):** on-device TTS (pt-BR voice) for notes, cards, questions and explanations; speed 0.75×–2×; current sentence highlighted; LaTeX converted to spoken PT-BR ("x ao quadrado mais 3"). |
| WEL-04.9 | **Voice input (Phase 3):** on-device speech recognition (pt-BR) in the tutor, Lucas, Argumentação, ✋ and short-answer questions; shows the recognized text for editing before sending. |
| WEL-04.10 | **Timed activities** (duels, battles, simulados) offer an accessibility time extension (1.5× or 2×) in settings for practice modes; competitive modes show that a player has extended time ("⏱️+") without other details. |

## 5. UX and screens

### 5.1 Screens

| Screen | Content |
|---|---|
| **Hoje** header | Capi, streak 🔥 with shield count 🛡️, daily goal ring (minutes), XP/level bar. |
| **Perfil → Progresso** | Level, total XP, streak history calendar (counted / shield / rest days), achievements grid. |
| **Mapa** (subject) | Skill tree with node states and bosses. |
| **Retrospectiva** | Full-screen story cards with share buttons. |
| **Modo foco** | Big countdown, current activity, pause/skip, Capi *focada*; break screen. |
| **Bloqueio** overlay | Shown over blocked apps (WEL-02.3). |
| **Perfil → Bem-estar** | Quiet hours, wellbeing nudges toggle, weekly check-in toggle, help card. |
| **Perfil → Acessibilidade** | Font, spacing, contrast, reduce motion, read-aloud voice/speed, time extension. |

### 5.2 Key PT-BR strings

| Context | String |
|---|---|
| Goal | "Meta do dia: {n} min" · "Meta batida! 🎉" · "Usar a meta do plano ({n} min)" |
| Streak | "Sequência: {n} dias 🔥" · "Você ganhou um escudo 🛡️! Se um dia você não conseguir estudar, ele protege sua sequência." · "Seu escudo protegeu sua sequência ontem 🛡️" · "Dia de descanso 😌" |
| Streak reset (shown on next open only) | "Sua sequência recomeçou. Seu recorde de {n} dias continua aqui — bora de novo, no seu ritmo 💪" |
| Reminder (never after 20:00) | "Que tal 5 minutinhos de revisão hoje? 📚" · "Tem {n} cartões te esperando — rapidinho!" |
| XP / level | "+{n} XP" · "Subiu pro nível {n}! 🎉" |
| Achievements | "Nova conquista: {nome}" · "Mostrar na turma" |
| Skill tree | "Mapa" · "Recomendado depois de: {tópico}" · "Dominado ✓" · "Esfriando — bora revisar?" · "Cai na prova" · "Chefão: {unidade}" · "Você derrotou o chefão! 🏆" |
| Capi | "A Capi tá descansando. Quando você voltar, ela vai estar aqui 💤" · "A Capi tá com sono… dormir também ajuda a memória 🌙" |
| Retrospectiva | "Sua Retrospectiva chegou ✨" · "Seu bimestre em uma frase" · "Mostrar notas" · "Compartilhar" |
| Focus | "Modo foco" · "Foco até {hh:mm}" · "Pausa! Levanta, bebe água, alonga 🧘" · "Voltou! Bora continuar?" · "Não perturbe durante o foco" |
| Blocking | "Bloquear apps durante o foco" · "Foco até {hh:mm}. Bora voltar?" · "Voltar pro Studify" · "Desbloquear por 5 min (segure)" · "Encerrar foco" |
| Burnout | "Já faz 50 minutos direto. Que tal uma pausa de 5? 🧘" · "Você já estudou bastante hoje. Descansar também faz parte — é dormindo que o cérebro fixa o que você aprendeu." · "Tá tarde! Dormir bem ajuda a lembrar tudo amanhã 🌙" · "Seus acertos caíram nos últimos minutos. Uma pausa pode ajudar." · "Essa semana tá puxada. Quer deixar os próximos dias mais leves?" · "Agora não" |
| Check-in | "Como você tá com os estudos?" |
| Help card | "Precisa conversar? O CVV atende de graça, 24 horas, pelo 188 ou no chat em cvv.org.br. Em emergência, ligue 192." |
| Accessibility | "Leitura facilitada" · "Alto contraste" · "Reduzir animações" · "Ouvir" · "Tempo extra em atividades com tempo" |

## 6. Data

### 6.1 Entities used
`profiles` (settings), `xp_events`, `achievements`, `streaks`, `study_sessions`, `plan_items`, `mastery`, `knowledge_nodes`, `node_prerequisites`, `quizzes`, `quiz_attempts`, `review_logs`, `goals`, `exams`, `class_group_members`.

### 6.2 New entities / fields

| Table | Column | Type | Purpose |
|---|---|---|---|
| `xp_events` | `user_id`, `amount` int, `source_feature` text (PRD ID), `ref_type`, `ref_id`, `occurred_at` timestamptz, `local_date` date, `in_quiet_hours` bool, `client_uuid` (idempotent sync) | | MOT-01, SOC-08 |
| `daily_activity` (new) | `user_id`, `local_date`, `active_minutes` int, `reviews` int, `questions` int, `sessions` int, `xp` int, `goal_minutes` int, `goal_met` bool, `counted` bool, `shield_used` bool, `rest_day` bool, `late_night_minutes` int | | streaks, burnout, Retrospectiva |
| `streaks` | `user_id` (PK), `current_length`, `longest_length`, `last_counted_date`, `shields_available` (0–2), `days_since_last_shield_earned`, `rest_weekday` (0–6, nullable) | | MOT-01.2–5 |
| `achievements` | `user_id`, `code` (definition in `packages/shared`), `progress` int, `unlocked_at`, `show_in_turma` bool | | MOT-01.8 |
| `boss_attempts` (new) | `user_id`, `unit_node_id`, `quiz_attempt_id`, `passed` bool, `score` | | MOT-02.4 |
| `retrospectives` (new) | `user_id`, `period_type` (`goal` / `semester` / `year`), `goal_id` (nullable), `period_start`, `period_end`, `stats` jsonb, `title` text, `generated_at`, `seen_at` | | MOT-04 |
| `study_sessions` | `kind` add `focus`; `planned_focus_minutes`, `cycles_planned`, `cycles_done`, `interruptions` int, `blocked_attempts` int, `dnd_used` bool | | WEL-01/02 |
| `wellbeing_nudges` (new) | `user_id`, `type` (`long_session` / `daily_load` / `late_night` / `performance_drop` / `overload_trend` / `checkin_low`), `shown_at`, `action` (`dismissed` / `accepted` / `disabled`) | | WEL-03.2 frequency caps |
| `profiles.settings` | `daily_goal_minutes`, `quiet_hours {start, end}`, `reminders_enabled`, `wellbeing_nudges_enabled`, `checkin_enabled`, `reduce_motion`, `font_family`, `letter_spacing`, `line_height`, `high_contrast`, `tts {voice, rate}`, `time_extension` (1 / 1.5 / 2), `mascot {visible, accessories}`, `semester_ends` | jsonb keys | MOT, WEL |

**Device-only data (never uploaded):** focus blocklist and installed-app list, foreground-app events, weekly check-in answers.

## 7. AI behavior

Only one AI task in this spec:

| Task | Details |
|---|---|
| Retrospectiva title (MOT-04.4) | Input: the stats JSON (no names, no free text). Output (structured): `{ title_pt: string (≤ 60 chars), subtitle_pt: string (≤ 120 chars) }`, playful and positive, no comparisons to others. Model `claude-opus-5-5`, effort `low`, `fallbacks: "default"`, Zod validation, `ai_usage` feature `MOT-04`. On failure: a fixed template ("Que bimestre, hein! ✨"). |

The **distress rule** (WEL-03.6) is a shared system-prompt fragment in `packages/prompts` included by every conversational feature (TUT, INT, CAM follow-ups): respond with empathy, do not continue the study task in that turn, never give medical advice, append `[[APOIO]]`. The app strips the marker and renders the help card.

## 8. Rules and algorithms

### 8.1 XP table

| Event | XP | Notes / anti-farming |
|---|---|---|
| Card reviewed (any rating) | 1 | Same XP for Again/Hard/Good/Easy (never reward lying "Easy"). No XP if the same card was reviewed < 10 min ago. |
| Question answered (first attempt today) | 2 | |
| … and correct | +1 | |
| Quiz completed (≥ 5 questions) | 5 | |
| Mock exam (Simulado) completed | 20 + 1 per question | |
| Boss defeated (MOT-02) | 50 | First time per unit; retries 10. |
| Plan item completed (GOL-04) | 5 | |
| Daily goal met | 10 | Once per day. |
| Mistake resolved (Caderno de Erros) | 3 | |
| Note section read (≥ 30 s and scrolled to end) | 2 | Max 20 XP/day from reading. |
| Ensine o Lucas finished | 10 + ⌊score/10⌋ | |
| Treino de Argumentação finished | 10 | |
| Podcast episode completed (≥ 90%) | 5 | Max 3/day. |
| Duel finished / won | 5 / +5 | |
| Battle played / top 3 | 5 / +10, +6, +3 | |
| Error report accepted (TRU-02) | 5 | |
| Focus cycle completed | 3 | |

- XP is computed server-side from synced events (`xp_events.client_uuid` idempotent); the app shows optimistic values.
- Personal XP is earned at any hour; **league XP** excludes quiet hours and is capped (see [10 §8.5](10-turma-social.md#8-rules-and-algorithms)).

### 8.2 Active study minutes
A minute counts as active if, within it, the user interacted with a study surface (review, question, note scroll, tutor message, Lucas, debate, camera result) **and** there was no idle gap > 90 s; podcast listening counts while playing; focus phases count per WEL-01.6. Computed on device per session, synced as `study_sessions` and aggregated into `daily_activity.active_minutes`.

### 8.3 Streak rules
- **Study day** (`counted = true`) if any of: ≥ 5 active minutes, ≥ 10 card reviews, 1 completed quiz/duel/battle/Lucas/debate session, or an exam of an active goal on that date (auto-counted).
- **Day boundary:** a study day runs from 04:00 to 03:59 local time (the same boundary everywhere in the app: `study_preferences`, [learning-engine.md §0.2](../engineering/learning-engine.md#02-time), data-model R9). *Rationale:* removes the "beat midnight" anxiety; it does **not** encourage late study because there are no reminders after 20:00 and late-night activity triggers the sleep nudge (§8.10).
- Evaluation runs when the next day starts (04:00) or at next sync:

```
for each day d after last_counted_date:
  if counted(d): length += 1
  elif rest_day(d) or auto_rest(d): pass                 # neither break nor extend
  elif shields_available > 0: shields_available -= 1; mark shield_used(d)
  else: length = 0
every 7 consecutive counted days → shields_available = min(2, shields_available + 1)
longest_length = max(longest_length, length)
```
- Auto rest days: dates of exams in an active goal and the day after a goal's last exam.
- Sync conflicts (offline on two devices): recompute from `daily_activity`, which is derived from synced events.

### 8.4 Levels
Total XP needed to reach level `L` (L ≥ 1): `threshold(L) = 50 × L × (L + 1)` → L1 = 100, L2 = 300, L3 = 600, L5 = 1,500, L10 = 5,500, L20 = 21,000, L30 = 46,500. Level 0 at 0 XP.

### 8.5 Achievement catalog (v1)

| Code | Name (PT-BR) | Criterion |
|---|---|---|
| `first_upload` | Primeiro material | Upload the first document |
| `first_review` | Primeira revisão | Review the first card |
| `streak_7` / `streak_30` / `streak_100` | 7 / 30 / 100 dias | Streak length reached |
| `cards_100` / `cards_1000` | 100 / 1.000 cartões | Total reviews |
| `questions_500` | 500 questões | Total questions answered |
| `mock_first` | Primeiro simulado | Complete a mock exam |
| `boss_first` | Caçador de chefões | Defeat a boss |
| `mistakes_20` | Caderno limpo | Resolve 20 mistakes |
| `calibrated` | Calibrado(a) | Calibration score in the "bem calibrado" band over 50 rated answers (PRA-05) |
| `lucas_90` | Nasceu pra ensinar | Lucas score ≥ 90 |
| `debate_5` | Bom de argumento | Finish 5 argumentation sessions |
| `duel_10` | Duelista | Finish 10 duels |
| `rematch_win` | Revanche! | Win a rematch |
| `turma_10` | Líder da turma | Create a Turma that reaches 10 members |
| `bug_hunter` | Caçador de erros | 3 accepted error reports |
| `focus_10` | Foco total | Complete 10 focus cycles |
| `exam_week_done` | Semana vencida | Finish all exams of a Semana de Provas with every plan day counted or rested |
| `consistent_week` | Semana consistente | Daily goal met on ≥ 4 days in a week |

No achievement rewards studying late, long single sessions, or total hours in one day.

### 8.6 Skill tree node states

| State | Rule |
|---|---|
| *recomendado depois* | Some prerequisite has mastery < 50% (shown dimmed with the prerequisite's name; still tappable) |
| *disponível* | Prerequisites ≥ 50% (or none) and the node's mastery = 0 |
| *em progresso* | 0 < mastery < 80% |
| *dominado* | mastery ≥ 80% and retrievability ≥ 0.7 |
| *esfriando* | mastery ≥ 80% but retrievability < 0.7 |

Mastery and retrievability come from [learning-engine](../engineering/learning-engine.md). Boss questions: 10 (≤ 4 topics) or 15 (> 4 topics) from the unit's question bank, weighted toward topics with lower mastery; pass ≥ 70%.

### 8.7 Quiet hours and notification rules
- Default quiet hours **22:00–07:00** local. Users can move the window (start 21:00–23:30, end 06:00–08:00) but cannot set it shorter than 8 h.
- During quiet hours: no push notifications of any kind (duel challenges, battle invites and reminders are held and delivered silently in-app at the end of quiet hours, or dropped if expired).
- Study reminders: never after 20:00 regardless of quiet hours.
- Global cap: max 3 push notifications per day from Studify (exam-day reminders from GOL count, but GOL's exam-day reminder has priority).

### 8.8 Focus timer implementation constraints (Android)
- The countdown must survive the app going to the background and Doze. Approach (detail in [mobile-app](../engineering/mobile-app.md)): a foreground service while a focus session runs, with an ongoing notification using a countdown chronometer; the end-of-phase alert is scheduled as an alarm.
- Android 12+ exact-alarm restrictions (`SCHEDULE_EXACT_ALARM` not granted by default on Android 14+): if not granted, rely on the foreground service timer; don't request the restricted `USE_EXACT_ALARM`.
- Foreground service type must be declared (Android 14+); choose the type that matches the use and is acceptable for a future Play listing (verify at implementation).
- Soft-focus app-switch detection (WEL-01.5): app moves to background **while the screen is on** (screen on/off broadcasts + AppState) → interruption.

### 8.9 App-blocking options evaluated (WEL-02)

| Option | How | Pros | Cons | Decision |
|---|---|---|---|---|
| **A. Soft focus** | Detect leaving Studify (WEL-01.5); DND optional | No special permissions; works everywhere | Doesn't stop anything | **Always on** as the baseline |
| **B. UsageStats + overlay** | `PACKAGE_USAGE_STATS` (special access) to read foreground app events, polled ~1 s by the focus foreground service; show a full-screen overlay window (`SYSTEM_ALERT_WINDOW`, `TYPE_APPLICATION_OVERLAY`) over blocked apps | Reliable enough; widely used by focus apps; no AccessibilityService; Play-compatible with a clear justification | Two special-access permissions (scary screens); ~1 s detection delay; small battery cost during sessions; overlay rules tightened on newer Android versions | **Chosen** for opt-in blocking |
| **C. AccessibilityService** | Window-change events | Instant detection | Google Play heavily restricts AccessibilityService for non-accessibility tools; on Android 13+ sideloaded APKs hit "restricted settings", so users must dig into App info to allow it — confusing and a big trust ask for teenagers | Rejected |
| **D. Device Policy / Digital Wellbeing** | `DevicePolicyManager.setPackagesSuspended`, Family Link | Real suspension | Requires device-owner/profile-owner provisioning (factory reset or work profile); Digital Wellbeing has no public API for third-party app timers | Rejected |

Installed apps for the picker are queried with a `<queries>` launcher intent filter (no `QUERY_ALL_PACKAGES`).

### 8.10 Burnout guard heuristics

| Heuristic | Trigger | Nudge |
|---|---|---|
| Long session | ≥ 50 min of continuous active study with no break ≥ 5 min (outside a focus timer, which already has breaks) | "Já faz 50 minutos direto…" (repeat at 90 min, stronger wording, once) |
| Daily load | Active minutes today > max(2 × daily goal, 180) | "Você já estudou bastante hoje…" |
| Late night | Active study between 23:00 and 05:00 on a night before a school day (Sun–Thu), ≥ 10 min | "Tá tarde! Dormir bem ajuda…" (Capi *sonolenta*) — once per night. On an exam eve (GOL-07 Modo Véspera), the threshold is 22:30. |
| Performance drop | Within a session, accuracy over the last 20 items ≥ 25 points below the first 20, or median response time up ≥ 50% | "Seus acertos caíram…" |
| Overload trend | ≥ 6 of the last 7 days with active minutes > 1.5 × goal **and** 7-day accuracy trending down | "Essa semana tá puxada…" + **Rebalancear plano** |
| Check-in low | Two consecutive lowest check-in answers | Supportive message + help card |

Caps per WEL-03.2. Nudges never appear during a timed activity (duel, battle, simulado); they wait until it ends.

### 8.11 `[[APOIO]]` handling
- Prompt fragment (all conversational features): if the user expresses hopelessness, self-harm, abuse, or severe distress → reply briefly with empathy in PT-BR, encourage talking to a trusted adult, append `[[APOIO]]`, and stop the study task for that turn.
- App: strip the marker, render the help card (WEL-03.5) under the message; log only an anonymous counter (no message content) for safety metrics.

## 9. Edge cases and errors

| Case | Handling |
|---|---|
| Travel / time-zone change | Day boundaries use the device time zone at event time; a day is never counted twice or skipped (server dedupes by `local_date` per event). |
| Offline for days, then sync | Streak and XP recomputed from synced events; shields applied retroactively in order. |
| Device clock manipulation | Server uses its own receive time if the client timestamp is > 24 h ahead or behind; such events don't extend streaks retroactively beyond 2 days. |
| User sets rest day to the same weekday as an exam | Exam auto-counts as a study day anyway. |
| Daily goal changed mid-day | Applies from the next day; today keeps the original goal. |
| Very small subject (no units) | Skill tree shows topics as one region; no boss (needs ≥ 2 topics). |
| Mastery data missing (new user) | All nodes *disponível*; Capi *curiosa*. |
| Usage-access or overlay permission revoked | Blocking silently degrades to soft focus; a banner in Modo foco explains how to re-enable. |
| Focus session killed by an aggressive battery manager (some OEMs) | On next open: "Seu foco foi interrompido pelo sistema" + link to battery optimization help for that OEM. |
| Screen reader + timed duel | Time extension applies; announced in TalkBack. |
| OpenDyslexic font with math | Math (KaTeX) keeps its own font for correctness. |
| Help card offline | Card is bundled in the app (no network needed). |

## 10. Metrics

- Daily goal hit rate during exam weeks; median active minutes per counted day.
- Streak distribution; % of streaks saved by shields; % of users who set a rest day.
- Reminder open rate; % of users who disable reminders (high = too pushy).
- Late-night active minutes per user per week (should **decrease** over time).
- Wellbeing nudges: shown, accepted, disabled rates; "Rebalancear plano" acceptance.
- Focus: sessions per user/week; completion rate; interruptions per session; blocked attempts per session (trend down = habit forming).
- Accessibility adoption: % using font scaling > 130%, Leitura facilitada, read-aloud, voice input.
- Safety: `[[APOIO]]` triggers (anonymous count) — monitored for prompt quality, not for individuals.

## 11. Acceptance criteria

- [ ] Streak evaluation matches §8.3 for a fixture calendar covering counted days, a rest weekday, an exam day, shield use, shield earning at 7 days, the 2-shield cap, and a reset (unit test).
- [ ] Activity at 01:30 counts for the previous day; activity at 03:05 counts for the new day.
- [ ] No push notification is delivered between 22:00 and 07:00 by default, and no study reminder after 20:00 (notification scheduler tests).
- [ ] No notification text in the codebase contains loss-framing ("perder", "vai acabar") for streaks (lint check on the copy file).
- [ ] Reviewing the same card twice within 10 minutes awards XP once; Again and Easy award the same XP.
- [ ] Level thresholds match §8.4 (unit test).
- [ ] The skill tree never prevents opening a topic; soft-locked nodes show the prerequisite name.
- [ ] Defeating a boss at ≥ 70% grants the badge and 50 XP once; retries grant 10.
- [ ] Capi shows the *descansando* mood (never sad) after 3+ days without activity.
- [ ] Retrospectiva share images contain no classmates' names and no grades unless "Mostrar notas" is on.
- [ ] A 25/5 focus session keeps counting down with the app in the background and the screen off for 25 min, and alerts at the end, on a Pixel and a Samsung test device.
- [ ] With blocking enabled, opening a blocked app during focus shows the overlay within 2 s; the dialer is never blocked; **Desbloquear por 5 min** requires a 10-s hold.
- [ ] No list of installed apps or foreground-app data is sent to the server (network inspection test).
- [ ] The late-night nudge appears at most once per night and only on school nights.
- [ ] A conversation message expressing distress in tutor/Lucas renders the help card with CVV 188 (prompt eval set).
- [ ] At 200% font size, the Hoje, review, quiz and notes screens have no clipped text (screenshot tests).
- [ ] All interactive elements on Phase 1 screens have TalkBack labels (automated a11y check).
- [ ] Read-aloud reads a note with LaTeX formulas in spoken PT-BR and highlights the current sentence.

## 12. Open questions

1. **Mascot:** a capybara named Capi is proposed (very Brazilian, teen-friendly). Keep it, or choose another character/name?
2. **Default quiet hours** 22:00–07:00 and the 8-hour minimum window: OK for your classmates' routines?
3. **Streak day boundary at 04:00** (app-wide study-day boundary): acceptable, or prefer plain midnight?
4. **App blocking (WEL-02):** worth the two special-access permissions for your group, or keep only soft focus in v1 of Phase 5?
5. **Weekly mood check-in:** keep it (device-only) or drop it entirely to avoid any sensitive-data concerns?
6. **LaTeX-to-speech for PT-BR:** evaluate whether an existing library (e.g. Speech Rule Engine) supports Portuguese well enough, or write a mapping for common school notation.
