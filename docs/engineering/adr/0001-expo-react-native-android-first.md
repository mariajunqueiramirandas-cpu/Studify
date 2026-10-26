# 0001 — Expo / React Native, Android first

| Status | Accepted |
|---|---|
| Date | 2026-10-26 |
| Related | [PRD](../../product/PRD.md) · [Mobile app](../mobile-app.md) · [Architecture](../architecture.md) |

## Context

- The product owner chose a **native mobile app**. Everyone in the target group (the owner and their classmates) uses **Android**.
- The team is small. The backend, worker and shared logic are all TypeScript, so one language everywhere lowers the cost of every feature.
- Features that need native capabilities: an offline SQLite store, a PDF viewer, a home-screen widget (MEM-04), notification actions, camera, background audio, and (Phase 5) app blocking.
- Distribution for now is an **install link** to classmates. There is no store listing (PRD §6).
- iOS should remain possible later without a rewrite.

## Decision

Build the app with **Expo (React Native, TypeScript), Expo Router and EAS**, and ship **Android only**:

- Use **development builds** (custom dev client), not Expo Go, because of native modules (`react-native-pdf`, `react-native-android-widget`, track player).
- Distribute APKs through **EAS internal distribution** (install link). Ship JS-only fixes through **EAS Update** with the `fingerprint` runtime-version policy.
- Isolate Android-only capabilities behind interfaces in `src/platform/` with no-op stubs elsewhere.

## Alternatives considered

| Option | Why not |
|---|---|
| **Native Kotlin + Jetpack Compose** | Best widget (Glance) and system integration. But it's a second language next to the TypeScript backend, no shared logic with the server (FSRS, grade math, planner would be written twice), and no path to iOS. The feature list doesn't need Compose-only capabilities. |
| **Flutter** | Good performance and UI. But it's Dart instead of TypeScript, so logic can't be shared with Edge Functions or the worker, and the team is less familiar with it. |
| **Bare React Native (no Expo)** | More manual native configuration. Expo's config plugins, EAS Build/Update and dev client remove most of that work. |
| **PWA / web app** | Rejected by the owner in favor of a native app. Weak Android widget/notification-action support and no reliable background audio. |

## Consequences

- **+** One language (TypeScript) across app, Edge Functions and worker. `packages/shared` runs everywhere.
- **+** OTA updates let fixes reach classmates without reinstalling.
- **+** iOS stays feasible later, except the widget (needs WidgetKit) and app blocking (needs Screen Time entitlements).
- **−** Some native features need community libraries whose maintenance must be watched (widget, PDF viewer). Each is wrapped behind our own interface so it can be replaced.
- **−** Classmates must allow "install unknown apps" for the install link, so PT-BR instructions are needed in onboarding.
- **−** The EAS-managed signing keystore must be backed up. Losing it blocks updates to installed APKs.
