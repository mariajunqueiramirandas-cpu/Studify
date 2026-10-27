# studify.vendua.com.br

The public link site (D-05), built with React + Vite: the landing page, the landing page for shared links
(SOC-09.4, S-EXT-03) and the Android App Links verification file. In production the API container builds it
(`apps/api/Dockerfile`, stage `site`) and serves `dist/` (`apps/api/src/site.ts`).

| Path | Serves |
|---|---|
| `/` | Short "what is Studify" page with the APK button |
| `/c/{code}`, `/i/{code}`, `/q/{token}`, `/b/{pin}` | The same `index.html`; the app reads the path and shows the code in big letters + Copiar, "Já tenho o app: abrir" (custom scheme), the APK button and install help |
| `/download` | 302 to the newest GitHub Release's `studify.apk` (served by the API, not by this bundle) |
| `/.well-known/assetlinks.json` | Android App Links verification |

When the app is installed and the links are verified, Android opens the app directly and this
page never shows.

## Commands

```sh
pnpm --filter @studify/site dev        # Vite dev server; /download and /api proxy to a local API on :3000
pnpm --filter @studify/site build      # dist/
pnpm --filter @studify/site test       # link parsing (vitest)
pnpm --filter @studify/site typecheck
```

`src/links.ts` maps each link route to its copy and its `studify://` deep link (the same targets as the app's
App Links, mobile-app.md §2.3). `src/App.tsx` has the two pages.

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
