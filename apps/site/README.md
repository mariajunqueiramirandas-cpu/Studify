# studify.vendua.com.br

The public link site (D-05), built with React + Vite: the landing page, the landing page for shared links
(SOC-09.4, S-EXT-03) and the Android App Links verification file. In production the API container builds it
(`apps/api/Dockerfile`, stage `site`) and serves `dist/` (`apps/api/src/site.ts`).

| Path | Serves |
|---|---|
| `/` | The landing page, "a página que esquece" (below), with the APK button |
| `/c/{code}`, `/i/{code}`, `/q/{token}`, `/b/{pin}` | The same `index.html`; the app reads the path and shows the code in big letters + Copiar, "Já tenho o app: abrir" (custom scheme), the APK button and install help |
| `/download` | 302 to the newest GitHub Release's `studify.apk` (served by the API, not by this bundle) |
| `/.well-known/assetlinks.json` | Android App Links verification |

When the app is installed and the links are verified, Android opens the app directly and this
page never shows.

## Commands

```sh
pnpm --filter @studify/site dev        # Vite dev server; /download and /api proxy to a local API on :3000
pnpm --filter @studify/site build      # dist/
pnpm --filter @studify/site test       # link parsing, the memory model, the tutor (vitest)
pnpm --filter @studify/site typecheck
```

`src/links.ts` maps each link route to its copy and its `studify://` deep link (the same targets as the app's
App Links, mobile-app.md §2.3). `src/App.tsx` picks the page: the landing page for `/`, the link page for the routes.

## The landing page: a página que esquece

The landing page is an apostila about Studify that forgets itself, so the visitor sees the problem the app solves
before reading about it. One second on the page is one hour.

It is built phone first, for students opening a WhatsApp link on an Android phone: the base styles are a 360 dp
screen (checked down to 320), the download button sits in the first screen's thumb zone, every target is at least
48 dp (blanks and page chips in running text get an invisible 48 px touch area), and the Mapa da Memória is a bar under
the thumb (the sheets, the page's memory, the clock, pause) that opens into the full map. From 960 px it becomes a
rail beside the sheets. The clock ticks 10 times a second and the ink repaints in steps, so a cheap phone is not
redrawing filters on every frame.

- **Forgetting.** A sheet starts fading once it has been on screen for 1.5 s. Its memory follows the app's own FSRS
  forgetting curve and default weights (`ts-fsrs`, as in `packages/shared/src/learning`), starting as weak as a card
  you missed. The ink erodes through an SVG filter (`ErosionFilters`), and key words turn into blanks.
- **Recall.** Tapping a blank offers three words. Picking one is a review: the sheet re-inks, and its stability grows
  (more when the recall was harder), so it lasts longer next time. A miss shrinks it, like "Errei" in the app.
- **What you do stays.** Only the text you read fades. The flashcard (real rating intervals for a new card), the
  plan chart (FSRS reviews until an exam), the tutor (answers only from this page and cites the sheet) and the
  Prova surpresa never erode. Right answers in the prova re-ink the sheet they came from.
- **Coming back.** The clock and the memory are kept in `localStorage`. Real time away counts too: two days away is
  20 years on the page, and a note offers "Começar do zero". The pause button stops the clock (WCAG 2.2.2).

| File | What |
|---|---|
| `src/memory.ts` | The model: retrievability, recall, erosion, the plan simulation, the clock format |
| `src/page-store.ts` | The page clock and memory store, persistence |
| `src/forgetting.tsx` | Sheets, eroding text and cloze blanks (`Txt` markup: `[palavra\|distrator\|distrator]`), the Mapa da Memória |
| `src/widgets.tsx`, `src/tutor.ts` | The flashcard, plan chart, tutor and Prova surpresa |
| `src/landing.tsx` | The sheets and their copy |

The mascot illustrations in `src/assets` are copies of `apps/mobile/assets/capi` (the site builds on its own).

## APK download

`android-release.yml` uploads each release's APK twice: under its versioned name and as `studify.apk`. GitHub
serves the newest release's file at `https://github.com/mariajunqueiramirandas-cpu/Studify/releases/latest/download/studify.apk`,
and `/download` redirects there, so the site, invite messages and QR codes can always use
`https://studify.vendua.com.br/download`. Set `APK_URL` in the API environment to point it elsewhere. The
repository must stay public for the download to work without a GitHub login.

## Other hosts

The API is the production host. `public/_redirects` (Netlify, Cloudflare Pages) and `vercel.json` (Vercel)
have the same rewrites and the `/download` redirect if the site is ever hosted on its own.

## Before going live
1. **assetlinks.json:** already lists the release key's SHA-256 for `com.studify.app` (generated 2026-10-27). If the
   keystore is ever replaced, update the fingerprint. It must be served as `application/json` over HTTPS with no redirect.
2. **Not here yet:** `/privacidade` (SP-13 privacy notice, needs legal review) and `/ajuda`; the app
   links to both.
