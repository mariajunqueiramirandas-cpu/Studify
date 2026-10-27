# Studify — Product Requirements Document (PRD)

| | |
|---|---|
| **Status** | Draft v1 — approved feature scope (plan v4) |
| **Platform** | Android app (Expo / React Native). iOS possible later from the same codebase. |
| **UI language** | Português (Brasil). Study content follows the language of the source material. |
| **Audience** | The owner and their classmates (shared accounts, shared classes). Not a public product yet. |
| **Related docs** | [Roadmap](roadmap.md) · [User flows](user-flows.md) · [Architecture](../engineering/architecture.md) · [Feature specs](../specs/) |

---

## 1. Vision

> **Upload your class material. Get a complete, personal study system — notes, flashcards, quizzes, a tutor and a day-by-day plan — that takes you to exam day ready. Every item links back to the page it came from.**

Studify turns the PDFs students already have (teacher slides, apostilas, notes, past tests) into everything they need to study, and then organizes their time around the exams that matter: a **school exam week** ("Semana de Provas") or **ENEM**.

## 2. Product principles

These come from learning science and are the tie-breakers for every design decision.

1. **Active recall over re-reading.** Most study time is spent answering, not highlighting. Every screen should push toward retrieval.
2. **Spaced repetition.** Reviews are scheduled just before you would forget (FSRS).
3. **Grounded in your material.** Every note, card, question and tutor answer cites its source page. When something is not in the material, Studify says so instead of inventing it.
4. **Adaptive.** Studify tracks mastery per topic and sends you to your weak spots.
5. **Fast start.** From upload to the first study session in under 2 minutes.
6. **Phone-first.** Short sessions, one-thumb use, works offline for reviews.
7. **Better together.** Classmates share material and study against each other, without making it a social network.

## 3. Users

| Persona | Description | Key needs |
|---|---|---|
| **Estudante de escola** (primary) | High-school student, 14–18, Android phone, studies for bimonthly/trimester exam weeks with many subjects at once. | Know what to study each day across 5–10 subjects; only study what is on the test; know the grade they need. |
| **Vestibulando ENEM** (secondary, later mode) | Same student (or a cursinho student) preparing for ENEM. | Practice in the ENEM format, essay correction, TRI-aware simulados, target score for their SISU course. |
| **Organizador(a) da turma** | The classmate who uploads the teacher's PDFs for everyone. | Share material once; whole class benefits; see what the class finds hard. |

> **Minors.** Most users are under 18. This shapes privacy, safety, social features and AI behavior. See [security-privacy.md](../engineering/security-privacy.md).

## 4. Modes (goals)

Every study effort is organized as a **Goal** (`Objetivo`). A goal has a mode:

| Mode | PT-BR name | Description | Phase |
|---|---|---|---|
| `exam_week` | **Semana de Provas** | A school exam period: several subjects, each with its own test date, weight and content list. | 1 |
| `enem` | **ENEM** | ENEM preparation: 4 areas + Redação, official question bank, TRI simulados, SISU target. | 4 |

**Subjects** (`Matérias`) and their materials are shared across goals — the Biologia PDFs uploaded for a school exam also count toward ENEM.

## 5. Feature catalog

Each feature has a stable ID used across specs, tickets, code comments and commits. **Phase** refers to the [roadmap](roadmap.md). **Spec** links to the detailed specification.

### 5.1 Platform (PLT)

Spec: [00-platform](../specs/00-platform.md), [mobile-app](../engineering/mobile-app.md)

| ID | Feature | Phase |
|---|---|---|
| PLT-01 | Android app (Expo), PT-BR UI, light/dark theme | 0 |
| PLT-02 | Accounts: sign-up/login (email magic link + Google), profile | 0 |
| PLT-03 | Subjects (Matérias): create, edit, archive, color/icon | 0 |
| PLT-04 | AI usage limits per user and per Turma; owner spend cap | 0 |
| PLT-05 | Notifications infrastructure (push + local) | 1 |
| PLT-06 | Distribution via install link (EAS internal distribution) | 0 |
| PLT-07 | Offline: reviews and downloaded notes work without internet; sync on reconnect | 1 (reviews), 2 (full) |

### 5.2 Ingestion & Knowledge Map (ING)

Spec: [01-ingestion-knowledge-map](../specs/01-ingestion-knowledge-map.md)

| ID | Feature | Phase |
|---|---|---|
| ING-01 | Upload PDFs per subject (slides, notes, textbooks, past tests, content lists); new material merges into the subject | 0 |
| ING-02 | Native PDF understanding (text, diagrams, charts, tables, scanned pages); automatic splitting of large files | 0 |
| ING-03 | Knowledge map: Subject → Units → Topics → Concepts, with key terms, formulas, learning objectives, page ranges and prerequisites | 0 |
| ING-04 | Outline review: rename, merge, split, delete, reorder topics; mark "não cai na prova" | 0 |
| ING-05 | Language detection; generated content in the material's language | 0 |
| ING-06 | Material checker: flags contradictions, typos, skipped steps in the source | 5 |
| ING-07 | Import school exam schedule / plano de ensino → creates subjects, exams, weights | 2 |
| ING-08 | In-app PDF viewer; 📄 page chips jump to page and highlight the passage | 0 |

### 5.3 Learn / Understand (LRN)

Spec: [02-learn-notes](../specs/02-learn-notes.md)

| ID | Feature | Phase |
|---|---|---|
| LRN-01 | Notes at 3 depths: Resumo rápido (TL;DR), Resumo (study notes per topic), Aprofundado (deep dive); formulas (LaTeX) and tables | 1 |
| LRN-02 | Glossary of key terms, auto-built, linked to pages | 1 |
| LRN-03 | "Explica de outro jeito": simpler, analogy, concrete example, step by step | 1 |
| LRN-04 | Interactive concept map + prerequisite detective ("you struggle with X because Y isn't solid") | 2 |
| LRN-05 | Auto visuals: diagrams, flowcharts, timelines, comparison tables generated from text | 5 |

### 5.4 Remember (MEM)

Spec: [04-flashcards-memory](../specs/04-flashcards-memory.md)

| ID | Feature | Phase |
|---|---|---|
| MEM-01 | Auto-generated flashcards (basic, cloze, reverse); editable; add your own | 1 |
| MEM-02 | FSRS scheduling and review sessions | 1 |
| MEM-03 | Image-occlusion cards (hide diagram labels) | 3 |
| MEM-04 | Review anywhere: home-screen widget, answer-from-notification | 2 |
| MEM-05 | Mapa da Memória: concepts glow/fade by predicted retention; tap to refresh | 2 |
| MEM-06 | Estúdio de Mnemônicos: acronyms, rhymes, stories, memory palaces | 5 |

### 5.5 Feed de Estudos (FED)

Spec: [06-feed-de-estudos](../specs/06-feed-de-estudos.md)

| ID | Feature | Phase |
|---|---|---|
| FED-01 | Vertical swipe feed of micro-lessons, quick questions and diagrams from your material, interleaved with due cards | 2 |

### 5.6 Practice & Exams (PRA)

Spec: [05-practice-exams](../specs/05-practice-exams.md), [08-prova-provavel](../specs/08-prova-provavel.md)

| ID | Feature | Phase |
|---|---|---|
| PRA-01 | Quizzes: multiple choice, true/false, fill-in, matching, ordering, short answer (AI-graded); Bloom levels | 1 |
| PRA-02 | Wrong-answer explanation + page link + auto-created flashcard | 1 |
| PRA-03 | Mock exams (Simulados) per subject or goal, timed | 1 |
| PRA-04 | Caderno de Erros: every mistake saved, classified by cause, targeted re-practice | 1 |
| PRA-05 | Medidor de Confiança: rate confidence before answering; calibration report | 2 |
| PRA-06 | Ache o Erro: statements/solutions with a planted mistake to find | 3 |
| PRA-07 | Essay-question grading (questões dissertativas), typed or photographed | 3 |
| PRA-08 | Problem sets with worked solutions and hint ladder | 3 |
| PRA-09 | Prova Provável (school): teacher's past tests → predicted test in the teacher's style | 2 |

### 5.7 Tutor (TUT)

Spec: [03-tutor](../specs/03-tutor.md)

| ID | Feature | Phase |
|---|---|---|
| TUT-01 | Chat grounded in your material, with page citations | 1 |
| TUT-02 | Modes: Responder, Socrático, Me testa | 1 |
| TUT-03 | Scope: whole subject, a goal, a topic, or a highlighted passage | 1 |
| TUT-04 | "Isso não está no seu material" behavior, with an optional clearly-labeled general answer | 1 |
| TUT-05 | Personalized by history (weak topics, past mistakes) | 2 |
| TUT-06 | Voice mode (speak and listen) | 3 |

### 5.8 Goals & Planning — Semana de Provas (GOL)

Spec: [07-goals-semana-de-provas](../specs/07-goals-semana-de-provas.md)

| ID | Feature | Phase |
|---|---|---|
| GOL-01 | Goals: create/edit/archive a goal (Semana de Provas or ENEM) | 0 (skeleton), 1 |
| GOL-02 | Exam calendar: each test with subject, date/time, weight | 1 |
| GOL-03 | Conteúdo da prova: type, paste or photograph the content list; everything is scoped to it | 1 |
| GOL-04 | Exam-week planner: backward planning from each test, balances all subjects, replans on misses | 1 |
| GOL-05 | "Hoje" screen: one button starts a mixed session (due cards, weak-topic quiz, new material) | 1 |
| GOL-06 | Quanto preciso tirar?: school grade rules, required grade per test, log results and replan | 1 |
| GOL-07 | Modo Véspera: night-before review per test | 1 |
| GOL-08 | Exam-week dashboard: countdown and readiness per subject | 1 |
| GOL-09 | Calendar sync (Google Calendar) | 5 |
| GOL-10 | Energy-aware scheduling (learns when you perform best) | 5 |
| GOL-11 | Predicted grade with confidence range | 2 |

### 5.9 Turma / Together (SOC)

Spec: [10-turma-social](../specs/10-turma-social.md)

| ID | Feature | Phase |
|---|---|---|
| SOC-01 | Turma: create/join via code, QR or WhatsApp link; shared subjects and materials | 2 |
| SOC-02 | Duelos: asynchronous 1v1 quiz duels | 2 |
| SOC-03 | Batalha ao vivo: live Kahoot-style class battle | 2 |
| SOC-04 | Class insights ("72% da turma erra isso"), anonymized | 2 |
| SOC-05 | Salas de estudo: shared focus timer, presence, group goals | 3 |
| SOC-06 | Dividir e conquistar: split topics, each writes a summary, AI merges | 5 |
| SOC-07 | Perguntas da turma: classmates write questions, AI validates, best go to everyone | 5 |
| SOC-08 | Weekly leagues (opt-in) | 5 |
| SOC-09 | Share a quiz to WhatsApp | 2 |

### 5.10 Câmera Mágica (CAM)

Spec: [11-camera-magica](../specs/11-camera-magica.md)

| ID | Feature | Phase |
|---|---|---|
| CAM-01 | Photograph a book page, whiteboard or handwritten notes → explain using your course, or add to the course | 3 |
| CAM-02 | Photograph a question/exercise → step-by-step solution, skill/topic, similar questions | 3 |
| CAM-03 | Photograph handwritten answers or essays for grading (PRA-07, ENM-05) | 3 |

### 5.11 Interactive Learning (INT)

Spec: [12-interactive-learning](../specs/12-interactive-learning.md)

| ID | Feature | Phase |
|---|---|---|
| INT-01 | Podcast Interativo: two hosts discuss your material in PT-BR; tap ✋ to ask, they answer and continue | 3 |
| INT-02 | Ensine o Lucas: teach a virtual student; scored on how well Lucas understands | 3 |
| INT-03 | Treino de Argumentação: the AI attacks your thesis; practice building arguments | 4 |

### 5.12 ENEM Mode (ENM)

Spec: [09-enem-mode](../specs/09-enem-mode.md), [08-prova-provavel](../specs/08-prova-provavel.md)

| ID | Feature | Phase |
|---|---|---|
| ENM-01 | ENEM structure: 4 areas + Redação; foreign language choice (Inglês/Espanhol); Matriz de Referência tagging (H1–H30 per area) | 4 |
| ENM-02 | Banco de Questões ENEM: official past questions with answer keys, tagged by area, subject, skill, difficulty | 4 |
| ENM-03 | ENEM-style questions generated from your material (texto-base + alternatives A–E) | 4 |
| ENM-04 | Simulado com TRI: full ENEM days, timed; TRI score estimate; coherence alerts; time and guessing coaching | 4 |
| ENM-05 | Correção de Redação: 5 competências (0–1000), per-competency feedback, proposta de intervenção checklist, repertório, rewrites, progress chart, theme generator | 4 |
| ENM-06 | Meta SISU: target course/university → past cut-off scores, area weights, target per area; plan weighting | 4 |
| ENM-07 | Plano até o ENEM: countdown, weekly balance across areas, 1–2 redações/week | 4 |
| ENM-08 | Prova Provável ENEM: topic frequency and trends across past ENEMs; likely redação themes | 4 |
| ENM-09 | Atualidades: weekly current-events digest for Humanas and Redação, with questions and repertório | 4 |
| ENM-10 | Reta Final: last weeks plan, review by area, exam-day logistics checklist | 4 |

### 5.13 Motivation (MOT) and Focus & Wellbeing (WEL)

Spec: [13-motivation-wellbeing](../specs/13-motivation-wellbeing.md)

| ID | Feature | Phase |
|---|---|---|
| MOT-01 | Streaks (with freeze), XP, daily goal, achievements | 2 |
| MOT-02 | Skill tree: the subject as a game map; topics unlock; units end in a "boss" mock test | 5 |
| MOT-03 | Mascot that grows as you study | 5 |
| MOT-04 | Retrospectiva (semester/year recap) | 5 |
| WEL-01 | Focus timer (Pomodoro) with persistent notification | 5 |
| WEL-02 | Block distracting apps during focus (Android permission) | 5 |
| WEL-03 | Burnout guard: notices overload, suggests breaks, sleep reminders | 5 |
| WEL-04 | Accessibility: font scaling, high contrast, dyslexia-friendly font, read-aloud, voice input | 1 (baseline), 3 (read-aloud/voice) |

### 5.14 Trust (TRU)

Spec: [01-ingestion-knowledge-map](../specs/01-ingestion-knowledge-map.md), [10-turma-social](../specs/10-turma-social.md)

| ID | Feature | Phase |
|---|---|---|
| TRU-01 | Page citations on every generated note, card, question and tutor answer | 0–1 |
| TRU-02 | Error flag on any item; fixes propagate to the whole Turma | 1 (flag), 2 (propagation) |

## 6. Non-goals (explicitly cut)

These were considered and **removed** by the product owner. Do not build them without a new decision.

- **Aula Gravada** (lecture recording + transcript alignment).
- **Prova Oral** (voice oral examiner).
- **Second-pass verification** of every generated item against the source (trust relies on citations + error flags instead).
- **Case simulations** (clinical/legal/business scenarios).
- iOS build at launch (code stays cross-platform, but only Android is built, tested and distributed).
- Public sign-up, payments, or a store listing at launch.

## 7. Success metrics

| Metric | Target (first exam week with the class) |
|---|---|
| Time from first upload to first study session | < 2 min (median) |
| Weekly active users among invited classmates | ≥ 60% during exam weeks |
| Review sessions completed per active user per exam week | ≥ 5 |
| Flagged-as-wrong rate on generated items | < 2% of items shown |
| Self-reported "Studify helped my grade" (post-exam survey) | ≥ 70% yes |
| AI cost per active user per month | Tracked from day 1; budget set by the owner (see PLT-04) |

## 8. Glossary

| Term (PT-BR, as in UI) | Code name | Meaning |
|---|---|---|
| Matéria | `subject` | A school subject (e.g. Biologia). Holds documents and the knowledge map. |
| Material | `document` | An uploaded file (PDF or image set). |
| Unidade / Tópico / Conceito | `knowledge_node` (`unit` / `topic` / `concept`) | Levels of the knowledge map. |
| Objetivo | `goal` | A study goal: Semana de Provas or ENEM. |
| Prova | `exam` | One test inside a goal (subject + date + weight + content scope). |
| Conteúdo da prova | `exam.scope` | The list of topics a test covers. |
| Resumo | `note` | Generated notes at one of 3 depths. |
| Flashcard / Cartão | `card` | A spaced-repetition card. |
| Questão | `question` | A practice question of any type. |
| Quiz / Simulado | `quiz` (`kind: practice | mock_exam`) | A set of questions taken in one attempt. |
| Caderno de Erros | `mistake` | A saved mistake with its cause. |
| Turma | `class_group` | A group of classmates sharing subjects. |
| Duelo / Batalha | `duel` / `battle` | Competitive quiz modes. |
| Domínio | `mastery` | Per-user, per-node mastery estimate (0–100%). |
| Hoje | Today screen | The daily entry point. |
| Redação | `essay` (ENEM) | ENEM essay, graded on 5 competências. |
| TRI | IRT | Teoria de Resposta ao Item — ENEM's scoring model. |
