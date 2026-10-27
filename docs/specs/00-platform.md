# 00 — Platform: app shell, accounts, subjects, limits, notifications, distribution, offline

| | |
|---|---|
| **Status** | Draft v1 |
| **Phase(s)** | 0 (PLT-01, 02, 03, 04, 06), 1 (PLT-05, PLT-07 reviews), 2 (PLT-07 full) |
| **Features** | PLT-01, PLT-02, PLT-03, PLT-04, PLT-05, PLT-06, PLT-07 |
| **Related** | [mobile-app.md](../engineering/mobile-app.md) (implementation), [security-privacy.md](../engineering/security-privacy.md) (obligations SP-01…SP-18), [architecture.md](../engineering/architecture.md), [04 — Flashcards & memory](04-flashcards-memory.md) (offline reviews), [10 — Turma & social](10-turma-social.md) (invites, shared subjects) |

---

## 1. Summary

This spec defines the user-facing behavior of everything that is not a study feature: the app shell and navigation, sign-up and onboarding (with the age gate and the invite-only pilot), the profile and settings, managing subjects (Matérias), how AI usage limits look to students and to the owner, notifications, how the app is installed and updated, and what works offline.

Implementation detail lives in [mobile-app.md](../engineering/mobile-app.md) and [security-privacy.md](../engineering/security-privacy.md). This spec states **what** must happen; those documents state **how**.

## 2. Goals and non-goals

**Goals**
- A classmate goes from tapping an install link to studying their first PDF in under 5 minutes, including installing the APK. Once installed, upload to first session takes under 2 minutes.
- The app is fully in PT-BR, works in light and dark mode, and is usable with one thumb.
- Legal and safety obligations for minors (SP-01 age gate, SP-02 invite gating, SP-05 protective defaults, SP-10 AI disclosure, SP-13 privacy notice, SP-14 data rights) are met from Phase 0.
- AI spending can never surprise the owner, and running out of AI never blocks studying already-generated material.

**Non-goals**
- Public sign-up, payments, a Play Store listing or iOS builds (PRD §6).
- Passwords (email magic link/code and Google only).
- Profile photos uploaded by users in v1 (preset avatars only, which avoids storing face photos of minors).
- A web version of the app.

## 3. User stories

| # | As a… | I want to… | So that… |
|---|---|---|---|
| US-1 | classmate | install the app from a WhatsApp link and sign in with my Google account | I can start without creating a password |
| US-2 | new user | be guided straight to uploading my first PDF | I see value in my first two minutes |
| US-3 | student | organize my material by Matéria with colors | I find things fast |
| US-4 | student | know when the AI limit for today is close | I'm not surprised mid-study |
| US-5 | student | get a reminder for my reviews, but never at night | the app helps without bothering me |
| US-6 | student | review my cards on the bus without internet | studying isn't blocked by my data plan |
| US-7 | owner | set AI limits per person and per Turma and get alerts | the shared API budget lasts the semester |
| US-8 | owner | push fixes to everyone without asking them to reinstall | bugs get fixed quickly |
| US-9 | student | download my data or delete my account myself | I control my data |

## 4. Functional requirements

### PLT-01 — App shell (Phase 0)

| ID | Requirement |
|---|---|
| PLT-01.1 | The app is an Android app built with Expo ([ADR 0001](../engineering/adr/0001-expo-react-native-android-first.md)). The minimum Android version is the minimum of the Expo SDK in use, checked at each SDK upgrade. |
| PLT-01.2 | Navigation uses five bottom tabs: **Hoje, Matérias, Praticar, Turma, Perfil** ([mobile-app.md §2](../engineering/mobile-app.md#2-navigation-expo-router)). A tab whose features are not released yet shows a short explainer with "Em breve" instead of being hidden, so the layout never changes under the user. |
| PLT-01.3 | Every UI string comes from the `pt-BR` i18n resource; no hard-coded strings in components (lint rule). Wording follows the [copy guide](../design/copy-pt-br.md). |
| PLT-01.4 | Theme follows the system (light/dark) with a manual override in Perfil → Configurações. |
| PLT-01.5 | Three global indicators are available on every screen: an **offline banner**, a **background-job pill** (e.g. "Gerando cartões… 40%", tap → job details), and a **limit banner** when PLT-04 limits are reached. |
| PLT-01.6 | Features are gated by server-side feature flags so a phase can be released to the Turma gradually ([architecture §5](../engineering/architecture.md#5-cross-cutting-conventions)). |
| PLT-01.7 | Every AI-generated item and AI conversation is labeled "Gerado por IA" (SP-10). Each tutor, Lucas and podcast session starts with the AI disclosure line from [security-privacy.md §2.2](../engineering/security-privacy.md#22-what-this-means-for-studify-concrete-obligations). |
| PLT-01.8 | A crash or unexpected error never shows a stack trace. The user sees a friendly PT-BR message and a "Tentar de novo" action; the error is reported to Sentry without personal content. |

### PLT-02 — Accounts and onboarding (Phase 0; guardian link Phase 2)

| ID | Requirement |
|---|---|
| PLT-02.1 | Sign-in methods: **Google** (native sign-in) and **email** with a magic link plus a 6-digit code fallback for when the link opens on another device. No passwords. |
| PLT-02.2 | **Invite-only pilot (SP-02).** Creating an account requires a valid invite: a Turma code/link or an owner invite. Without one, the user sees how to get an invite and no account is created. |
| PLT-02.3 | **Age gate (SP-01).** The user enters birth month and year before any other personal data. Users under 12 see "A Studify é para estudantes a partir de 12 anos." No account is created and nothing is stored. The age rule is in §8.1. |
| PLT-02.4 | **Guardian link (SP-03), Phase 2.** Users under 16 are asked for a responsável's email before Turma social features (SOC-*) unlock. Whether this is mandatory or recommended is an owner decision (§12). |
| PLT-02.5 | **Profile:** display name (required, 2–30 characters, moderated before other members can see it; SP-11), preset avatar, school year (`9º ano EF`, `1º ano EM`, `2º ano EM`, `3º ano EM`, `Cursinho`, `Outro`). No school name, no phone number, no photo (data minimization, LGPD Art. 14 §4). |
| PLT-02.6 | **Onboarding sequence** (screens S-AUTH-01…08 in [ux-guidelines.md](../design/ux-guidelines.md)): Entrar → (código) → convite (new accounts only) → idade → (responsável, if required) → seu perfil (incl. the privacy notice and its acceptance) → "Pra que você vai estudar?" → primeira matéria + upload. While the first upload processes, the app offers "Criar sua Semana de Provas" (GOL-01) and starts the first session as soon as the outline exists (ING-03). |
| PLT-02.7 | The privacy notice (SP-13) is shown in plain PT-BR during onboarding, with a short teen-friendly summary on top and the full text one tap away. Acceptance is stored with the notice version. A new notice version asks for acceptance again on next launch. |
| PLT-02.8 | **Sign out** ("Sair") clears local data. If the device has unsynced reviews in the outbox, sign-out first tries to sync; if offline, it warns "Você tem revisões que ainda não foram salvas na nuvem" and offers to wait. "Sair de todos os dispositivos" revokes all sessions. |
| PLT-02.9 | **Export and deletion (SP-14)** are self-service in Perfil → Privacidade: export produces a JSON + CSV archive; deletion follows the process and grace period in [security-privacy.md §10](../engineering/security-privacy.md#10-data-retention-export-and-deletion). Content the user uploaded to a Turma follows the same section's rules for shared content. |

### PLT-03 — Subjects / Matérias (Phase 0)

| ID | Requirement |
|---|---|
| PLT-03.1 | Create a Matéria with a name (with suggestions: Matemática, Português, Literatura, Redação, Inglês, Espanhol, Física, Química, Biologia, História, Geografia, Filosofia, Sociologia, Artes, Educação Física), a color from a fixed palette of 12 accessible colors, and an icon. Creating a Matéria with an existing name (case- and accent-insensitive) asks "Já existe uma matéria com esse nome. Criar mesmo assim?" |
| PLT-03.2 | The **Matérias** tab lists active subjects with color, icon, number of materials, overall mastery (Phase 2) and a badge for Turma-shared subjects. Subjects can be pinned and reordered. |
| PLT-03.3 | **Subject home** shows the knowledge-map outline (ING-03), materials (ING-01) with processing status, and quick actions: Revisar, Praticar, Perguntar ao tutor, Adicionar material. |
| PLT-03.4 | Edit name, color and icon at any time. **Archive** hides the subject everywhere (plans, Hoje, reviews) but keeps content and learning state; it can be restored. **Delete** (personal subjects only) asks for typed confirmation of the subject name and removes content and per-user state for that subject. |
| PLT-03.5 | Each subject has a content language, auto-detected from its first material (ING-05) and overridable. |
| PLT-03.6 | A subject is personal or shared with a Turma ([architecture §3.2](../engineering/architecture.md#32-ownership-and-sharing-rules)). Sharing and the related permissions are specified in [10 — Turma & social](10-turma-social.md). |
| PLT-03.7 | Phase 4: a subject can be mapped to an ENEM area (Linguagens, Humanas, Natureza, Matemática) and to a Redação track ([09 — ENEM mode](09-enem-mode.md)). |
| PLT-03.8 | Limit of 30 active (non-archived) subjects per user, to keep plans and storage sane. |

### PLT-04 — AI usage limits (Phase 0)

| ID | Requirement |
|---|---|
| PLT-04.1 | Every AI call passes the server-side budget gate `ai_budget_reserve` ([security-privacy.md §7](../engineering/security-privacy.md#7-rate-limiting-and-ai-budgets-plt-04)) before Claude is called, and settles the real cost in `ai_usage` afterwards. |
| PLT-04.2 | **Student view** (Perfil → Uso de IA): a simple meter of today's AI usage as a percentage, never dollars ("Você usou 60% do seu limite de IA de hoje"), plus which features used it. The meter resets at local midnight (America/Sao_Paulo). |
| PLT-04.3 | At **80%** of the daily limit, a one-time gentle notice appears in the app (not a push). At **100%**, AI actions show the limit state with the reset time. Everything already generated keeps working: reviews, existing quizzes, notes, glossary, the PDF viewer, Caderno de Erros, plans. |
| PLT-04.4 | **Ingestion and limits.** Before an upload starts processing, its estimated cost is reserved. If the reservation fails, the user can process **only the outline now** (cheap) and the rest is scheduled for the next day, or cancel. Already-running jobs are never killed halfway by the daily limit; they settle against it. |
| PLT-04.5 | **Shared Turma content** is charged to the Turma's monthly budget, not to the member who uploaded it ([architecture §3.2 rule 4](../engineering/architecture.md#32-ownership-and-sharing-rules)). The Turma owner sees the Turma's usage as a percentage. |
| PLT-04.6 | **Owner controls.** The owner (role `app_admin`) sets the per-user daily limit, per-Turma monthly limit and global monthly cap, and receives alerts at 80% and 100% of the global cap and when a user exceeds 5× the median daily spend. Phase 0: configured through environment config and SQL. Phase 1: an owner-only screen Perfil → Administração with spend by day, feature and Turma. |
| PLT-04.7 | Rate limit of 10 AI requests per user per minute and 60 tutor messages per day ([security-privacy.md §7](../engineering/security-privacy.md#7-rate-limiting-and-ai-budgets-plt-04)), with the PT-BR messages in §5. |

### PLT-05 — Notifications (Phase 1)

| ID | Requirement |
|---|---|
| PLT-05.1 | Notification channels, local vs push split and limits follow [mobile-app.md §5](../engineering/mobile-app.md#5-notifications). |
| PLT-05.2 | Notification permission is requested **in context** after the first upload ("Quer que eu avise quando seu material estiver pronto?"), never at first launch. If denied, the app works fully and Perfil → Notificações explains how to enable it. |
| PLT-05.3 | **Quiet hours** default to 22:00–07:00. Users can move them; users under 18 cannot turn them off entirely (minimum 8 hours). Nothing is delivered during quiet hours; the most recent notification of each type is delivered at the end of quiet hours if still relevant, and the rest are dropped. |
| PLT-05.4 | At most **3 unrequested notifications per day**. Reminders the user explicitly set (e.g. a daily plan reminder at 18:00) and "material pronto" don't count. |
| PLT-05.5 | Per-channel toggles in Perfil → Notificações: Revisões, Plano de estudos, Turma, Processamento. |
| PLT-05.6 | Every notification deep-links to the exact screen ([mobile-app.md §2.3](../engineering/mobile-app.md#23-deep-links)). Push tokens are registered per device on sign-in, refreshed on change, and removed on sign-out or when FCM reports them invalid. |
| PLT-05.7 | Notification catalog for Phase 1 is in §8.4. Later phases add types in their own specs, and each new type must be added to the catalog with its channel and whether it counts toward the daily cap. |

### PLT-06 — Distribution and updates (Phase 0)

| ID | Requirement |
|---|---|
| PLT-06.1 | The app is distributed as an APK through an **install link** (EAS internal distribution; [mobile-app.md §17](../engineering/mobile-app.md#17-builds-distribution-and-updates)). The invite message includes the install link and step-by-step PT-BR instructions for allowing installs from the browser. |
| PLT-06.2 | JS-only fixes ship as **OTA updates**, downloaded in the background and applied on the next cold start. Native changes need a new APK; the app shows "Nova versão disponível" with the install link. |
| PLT-06.3 | When the installed build is older than the server's `min_supported_version`, the app shows a blocking update screen. Unsynced reviews are kept in local storage and sync after the update. |
| PLT-06.4 | Two release tracks: **preview** (owner and volunteer testers) and **production** (everyone). A production OTA update rolls out to 20% for 24 h, then 100%. |
| PLT-06.5 | Perfil → **Enviar feedback** lets a user send a short text plus optional screenshot to the owner, with app version and device model attached automatically. |
| PLT-06.6 | Perfil → **Novidades** shows the latest release notes in PT-BR (one short list per version). |

### PLT-07 — Offline (Phase 1 reviews, Phase 2 full)

| ID | Requirement |
|---|---|
| PLT-07.1 | **Phase 1:** flashcards, card states and review logging work fully offline for all active subjects ([04 — MEM-02](04-flashcards-memory.md), [architecture §4.2](../engineering/architecture.md#42-review-offline-first-mem-02)). Notes for topics in the scope of upcoming exams are downloaded automatically. |
| PLT-07.2 | **Phase 2:** a subject can be downloaded for offline use: notes, glossary, pre-generated quizzes and Feed items, and PDF files. Quizzes taken offline are graded on device for objective types; short answers and essays are queued for AI grading when back online. |
| PLT-07.3 | AI features (tutor, explain-differently, grading, generation) show an offline state and are never silently queued, except the items in PLT-07.2. |
| PLT-07.4 | Perfil → **Armazenamento** shows space used per subject, lets the user remove downloads, and sets a cache limit (default 500 MB). When the limit is reached, least-recently-opened PDFs are evicted first; review data is never evicted. |
| PLT-07.5 | A sync indicator shows "Tudo salvo" / "Sincronizando…" / "X revisões aguardando internet". Sync conflicts follow [mobile-app.md §4.3](../engineering/mobile-app.md#43-sync-protocol). |

## 5. UX and screens

| Screen | Purpose | Notes |
|---|---|---|
| Entrar | Choose Google or email | First screen after install |
| Código | 6-digit code entry | Also handles the magic-link deep link |
| Convite | Enter a Turma/owner invite code | Skipped when the user arrived through an invite link |
| Idade | Birth month + year | Age gate (PLT-02.3) |
| Responsável | Guardian email | Phase 2; only when required (PLT-02.4) |
| Seu perfil | Name, avatar, school year, teen-friendly privacy summary + full notice | Acceptance stored with version (PLT-02.7) |
| Pra que você vai estudar? | Semana de Provas / ENEM / one subject | Sets the Hoje call to action only (GOL-01) |
| Primeira matéria | Create subject + upload | Leads into ING-01 |
| Perfil (tab) | Profile, goals, settings, privacy, usage, storage, feedback, novidades | |
| Uso de IA | Today's usage meter | PLT-04.2 |
| Administração | Owner-only spend dashboard | Phase 1 |
| Armazenamento | Downloads and cache | PLT-07.4 |
| Atualização obrigatória | Blocking update screen | PLT-06.3 |

### Key strings (PT-BR)

| Context | String |
|---|---|
| Sign-in title | "Envie o material da aula. Receba um sistema de estudos completo." |
| Google button | "Entrar com Google" |
| Email button | "Entrar com e-mail" |
| Email sent | "Enviei um código pro seu e-mail. Digite aqui:" (the same e-mail also carries the magic link) |
| Generic email response | "Se este e-mail estiver cadastrado, você vai receber um código." |
| Invite needed | "Tem um código de convite?" · "Peça pra quem organiza a sua turma ou pra quem te chamou pro Studify." |
| Invalid invite | "Código inválido ou expirado. Peça um novo pra quem organiza a turma." |
| Age question | "Quando você nasceu?" |
| Under 12 | "A Studify é para estudantes a partir de 12 anos." |
| Guardian ask | "Qual é o e-mail do seu responsável?" · "Para quem tem menos de 16 anos, o Studify avisa seu responsável e ele pode acompanhar seu tempo de estudo. Suas respostas e anotações continuam só suas." |
| Privacy summary title | "O que o Studify faz com seus dados (versão curta)" |
| Privacy accept | "Li e concordo" |
| Display name rejected | "Esse nome não pode ser usado. Que tal outro?" |
| First subject prompt | "Qual matéria você quer estudar primeiro?" |
| Duplicate subject | "Já existe uma matéria com esse nome. Criar mesmo assim?" |
| Archive confirm | "Arquivar {matéria}? Ela some do seu plano, mas nada é apagado." |
| Delete confirm | "Isso apaga a matéria, os materiais e seu progresso nela. Digite **{matéria}** para confirmar." |
| Coming soon tab | "Em breve: estude junto com a sua turma." |
| AI meter | "Você usou {p}% do seu limite de IA de hoje." |
| AI 80% notice | "Você já usou boa parte da IA de hoje. Revisões e o que já foi gerado continuam liberados." |
| AI limit reached | "Seu limite de IA de hoje acabou. O que não precisa de IA continua funcionando — e eu continuo o resto amanhã." |
| Rate limited | "Calma! Tenta de novo em instantes." |
| Upload over limit | "Esse material é grande pra IA de hoje. Quer que eu gere só o sumário agora e o resto amanhã?" |
| Offline banner | "Sem internet — revisões e resumos baixados continuam funcionando." |
| Sync states | "Tudo salvo" · "Sincronizando…" · "{n} revisões aguardando sincronização" |
| Unsynced sign-out | "Você tem revisões que ainda não foram salvas na nuvem. Quer esperar a internet voltar?" |
| Notification permission | "Quer que eu avise quando seu material estiver pronto?" |
| New version | "Nova versão disponível. Toque pra instalar." |
| Forced update | "Tem uma versão nova do Studify. Atualize pra continuar." (unsynced reviews stay on the phone, PLT-06.3) |
| AI label | "Gerado por IA" |
| Error fallback | "Algo deu errado. Tenta de novo?" |

## 6. Data

Entities used: `profiles`, `subjects`, `class_groups`, `class_group_members`, `ai_usage`, `feature_flags`, `app_versions`, `guardian_links` ([security-privacy.md](../engineering/security-privacy.md)). Full schema in [data-model.md](../engineering/data-model.md).

### 6.1 New entities / fields

| Table | Column | Type | Purpose |
|---|---|---|---|
| `profiles` | `birth_year`, `birth_month` | smallint | Age gate (PLT-02.3); no full birth date stored |
| `profiles` | `school_year` | enum | PLT-02.5 |
| `profiles` | `avatar_preset` | text | Preset avatar id (no uploads in v1) |
| `profiles` | `display_name_status` | enum `pending` / `approved` / `rejected` | Moderation state (SP-11) |
| `profiles` | `privacy_notice_version`, `privacy_accepted_at` | text, timestamptz | PLT-02.7 |
| `profiles` | `role` | enum `user` / `app_admin` | Owner controls (PLT-04.6) |
| `profiles` | `settings` | jsonb | theme, quiet hours, channel toggles, cache limit, flags |
| `invites` | `id`, `code`, `created_by`, `class_group_id` (nullable), `uses_left`, `expires_at`, `revoked_at` | | Pilot gating (PLT-02.2); Turma invites reuse this table ([10](10-turma-social.md)) |
| `push_tokens` | `id`, `user_id`, `device_id`, `token`, `platform`, `last_seen_at`, `invalidated_at` | | PLT-05.6 |
| `notification_log` | `id`, `user_id`, `type`, `channel`, `counts_toward_cap`, `scheduled_for`, `sent_at`, `dropped_reason` | | Daily cap and quiet-hours audit (PLT-05.3, 05.4) |
| `app_feedback` | `id`, `user_id`, `text`, `screenshot_path`, `app_version`, `device_model`, `created_at` | | PLT-06.5 |
| `release_notes` | `version`, `published_at`, `items` (jsonb, PT-BR) | | PLT-06.6 |
| `subjects` | `pinned`, `sort_order`, `archived_at`, `content_language` | | PLT-03.2, 03.4, 03.5 |

## 7. AI behavior

| Task | Feature | Input | Output | Effort | Mode |
|---|---|---|---|---|---|
| Display-name moderation | PLT-02.5 (SP-11) | The proposed display name only | Structured output `{ allowed: boolean, reason_code: "ok" \| "offensive" \| "personal_data" \| "impersonation" \| "other" }` | `low` | Sync (Edge Function) |

- A local blocklist runs first; the AI check only runs when the blocklist passes.
- Model `claude-opus-5-5`, server-side refusal fallbacks enabled, logged to `ai_usage` with feature `PLT-02`. A refusal or error leaves the name `pending` (visible only to the user) and retries later; it never blocks onboarding.
- Subject names and other text visible to a Turma are moderated in [10 — Turma & social](10-turma-social.md).

## 8. Rules and algorithms

### 8.1 Age gate

Only birth month and year are collected. To err on the protective side, age is computed as if the birthday were the **last day** of the birth month:

```ts
function ageInYears(birthYear: number, birthMonth: number, today: LocalDate): number {
  const birthday = lastDayOfMonth(birthYear, birthMonth);
  let age = today.year - birthday.year;
  if (today.month < birthday.month || (today.month === birthday.month && today.day < birthday.day)) age--;
  return age;
}
// < 12 → blocked (SP-01). < 16 → guardian link required/recommended (SP-03). < 18 → quiet hours can't be disabled.
```

A user who was blocked can try again after their 12th birthday. Nothing about the blocked attempt is stored.

### 8.2 Invite codes

- 8 characters from the same alphabet as Turma codes (SOC-01.2): `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no `0 O 1 I L`), shown in groups of 4 (`K7QX-9HMR`).
- Owner (pilot) invites: single-use, expire in 14 days. Turma invites: expiry, max uses and regeneration per SOC-01.4 in [10 — Turma & social](10-turma-social.md). Both live in the `invites` table.
- Bootstrap code `STUDYF26` (`BOOTSTRAP_INVITE_CODE` in `apps/api/src/functions/signup-complete.ts`): the first account has no one to invite it, so while no `app_admin` exists this code creates the account as the owner (`app_role = app_admin`). Once an owner exists it is rejected as `invite_invalid`.
- Codes are compared case-insensitively. Invalid-code attempts follow SOC-01.14: at most 5 per minute and 20 per hour per user/device and per IP; after 20 failures in an hour, joining is blocked for 1 hour.

### 8.3 Budget display

- Student meter = `round(100 × used_today / daily_limit)`, capped at 100. Pending reservations count as used.
- The 80% notice fires once per day per user.

### 8.4 Notification catalog (Phase 1)

| Type | Feature | Channel | Local / push | Counts toward cap | Deep link |
|---|---|---|---|---|---|
| `material_ready` | ING-01 | Processamento | Push | No | Subject home |
| `reviews_due` | MEM-02 | Revisões | Local | Yes | Review session |
| `daily_plan` | GOL-04 | Plano de estudos | Local | No (user-set time) | Hoje |
| `exam_eve` | GOL-07 | Plano de estudos | Local | No (user-set) | Modo Véspera |
| `grade_log_prompt` | GOL-06 | Plano de estudos | Local | Yes | Log grade for the exam |

Scheduling rules:
1. A notification whose delivery time falls in quiet hours is moved to the end of quiet hours. If another notification of the same type is already waiting, only the newest is kept.
2. Before sending an unrequested notification, the sender checks today's count in `notification_log` (local reminders check the on-device log). Over the cap → dropped with `dropped_reason = 'daily_cap'`.
3. `reviews_due` fires at most once per day, only if ≥ 5 cards are due, at the user's usual study time (default 18:00).

### 8.5 Cache eviction

When downloads exceed the cache limit, evict in this order until under the limit: PDF files by least-recent open → Feed items → pre-generated quizzes → notes of topics not in an upcoming exam's scope. Review data (cards, states, outbox) is never evicted.

## 9. Edge cases and errors

| Case | Behavior |
|---|---|
| Magic link opened on a computer | The web page shows the 6-digit code to type in the app. |
| Google account with a different email than an existing email account | Treated as different accounts in v1. Account linking is an open question. |
| Invite link opened without the app installed | Landing page with the install link and instructions ([mobile-app.md §2.3](../engineering/mobile-app.md#23-deep-links)); the invite code is kept and pre-filled after install. |
| Invite expired or used up | "Código inválido ou expirado…" and no account is created. |
| User enters an age under 12 by mistake | They can go back on the same screen. After leaving the screen, the app has stored nothing, so starting again works. |
| Under-16 user without a guardian email (if mandatory) | Study features work; Turma social features stay locked with an explainer. |
| Play Protect warns about the APK | Instructions in the invite explain the warning and how to continue. |
| Device clock wrong | Reviews still work. The server flags `clock_skew` on the logs ([mobile-app.md §4.3](../engineering/mobile-app.md#43-sync-protocol)), and plan dates use server time when online. |
| Low storage on the phone | Downloads pause with "Pouco espaço no celular"; reviews keep working. |
| Notification permission denied | Everything works; reminders show inside Hoje instead. |
| Daily AI limit reached during onboarding | The first upload always gets at least its outline: onboarding's first outline is exempt from the per-user daily limit but still counts toward the global cap. |
| Global monthly cap reached | All AI actions show the limit state; the owner is alerted; studying existing material continues. |
| App killed during an OTA download | The old bundle runs; the update retries next launch. |
| User signs in on a second phone | Data downloads; reviews from both phones merge through the sync rules. |

## 10. Metrics

| Metric | Target |
|---|---|
| Install-link tap → signed in | ≥ 80% of invited classmates |
| Onboarding completion (signed in → first upload) | ≥ 85% |
| First upload → first study session | < 2 min median |
| Notification opt-in | ≥ 60% |
| Crash-free sessions | ≥ 99.5% |
| Sync failure rate (outbox pushes failing after retries) | < 0.1% |
| Users hitting the daily AI limit | Tracked; > 10% of active users on a day → the owner reviews limits |

## 11. Acceptance criteria

- [ ] Installing from the link, signing in with Google, passing the age gate, accepting privacy and uploading a PDF works on a mid-range Android phone with no English text anywhere.
- [ ] Without an invite, no account is created (verified in the database).
- [ ] An under-12 birth date blocks sign-up and leaves no row in any table.
- [ ] Ages are computed with the last-day-of-month rule (unit tests at month boundaries).
- [ ] A display name rejected by moderation is never visible to other users.
- [ ] Creating, editing, pinning, archiving, restoring and deleting a subject works; delete requires typing the name.
- [ ] With the daily AI limit set very low, the meter, the 80% notice and the 100% state appear as specified, and reviews, notes and existing quizzes still work.
- [ ] Two parallel AI requests cannot overspend the budget (server test).
- [ ] No notification arrives during quiet hours; the 4th unrequested notification of a day is dropped and logged.
- [ ] Users under 18 cannot set quiet hours shorter than 8 hours.
- [ ] Airplane mode: reviews work, the offline banner shows, AI actions show the offline state; reconnecting syncs reviews exactly once.
- [ ] An OTA update reaches a production device and applies on next cold start; a build below `min_supported_version` shows the blocking update screen and keeps unsynced reviews.
- [ ] Export produces a readable archive; account deletion follows the security-privacy process.

## 12. Open questions

| # | Question | Owner decision needed |
|---|---|---|
| 1 | Minimum age: 12 (legal floor without parental consent) or 14 (fewer obligations)? | Yes ([security-privacy.md §14](../engineering/security-privacy.md#14-open-questions-owner-decisions)) |
| 2 | Is the guardian link for under-16 users mandatory or only recommended? | Yes |
| 3 | Who is the legal controller if the owner is a minor? | Yes |
| 4 | Domain for HTTPS invite links, the landing page and the privacy notice. | Yes |
| 5 | Should Google and email accounts with the same address be linked automatically? | Can default to "no" for v1 |
| 6 | Default cache limit (500 MB proposed). | Can default |
| 7 | Should the owner-only Administração screen exist in the app (Phase 1) or stay in the Supabase dashboard? | Can default to in-app |
