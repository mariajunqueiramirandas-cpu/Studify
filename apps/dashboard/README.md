# Painel Studify (`/painel`)

The web dashboard, built with React + Vite and served by the API container at `https://studify.vendua.com.br/painel`
(`apps/api/src/dashboard.ts`). Interface in PT-BR, light and dark, down to phone width.

- **Minha conta** (every student): Início (AI use today as a share of the limit, the study week), Perfil (name,
  school year, timezone, ENEM language, theme), Notificações (channels, quiet hours with the under-18 rule), Turmas
  (league, duels, class statistics, leave), Dispositivos (stop notifications, sign out everywhere), Privacidade e
  dados (download, start over, delete, with a fresh e-mail code).
- **Administração** (`profiles.app_role = 'app_admin'` only): Visão geral (what needs attention, spend against the
  global cap and its pace, people, operations), Uso de IA, Usuários (search, filters, one person with role, name
  review, suspension and daily limit), Turmas (monthly limits), Moderação (reports, flagged content, names, feedback),
  Convites (pilot invites), Configurações (AI limits, feature flags, minimum app version), Registro (audit log).

Sign-in is the same 6-digit e-mail code as the app, through Supabase Auth only (`@supabase/auth-js`). The web never
creates an account (`shouldCreateUser: false`; sign-up needs an invite, in the app). Everything else goes through the
API functions in [api.md §4.12](../../docs/engineering/api.md#412-web-dashboard-painel), which check the session and
the admin role; the page only decides what to show. Students never see money: AI use is a percentage.

## Runtime settings

The API writes the Supabase project URL and publishable key into `index.html` (`<meta name="studify-config">`) when
it serves the page, so one build works everywhere. The page is sent with a strict Content-Security-Policy (scripts,
styles and fonts from this origin, network to this origin and Supabase), never framed or indexed. Fonts (Bricolage
Grotesque, Figtree) are bundled: no third-party requests.

## Commands

```sh
pnpm --filter @studify/dashboard dev        # Vite on :5173/painel/; /api goes to a local API on :3000
pnpm --filter @studify/dashboard build      # dist/, served by the API at /painel (DASHBOARD_DIR)
pnpm --filter @studify/dashboard test       # formatting, routing, ids, chart geometry, overview alerts
pnpm --filter @studify/dashboard typecheck
```

For `dev`, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (or `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`).

## Layout

| Path | What |
|---|---|
| `src/App.tsx` | Session gate, routes, admin pages loaded on demand |
| `src/Shell.tsx` | The rail (a drawer on phones) and the page sheet |
| `src/lib/` | API client (Idempotency-Key UUID v7), Supabase Auth, router, cached reads, PT-BR formatting |
| `src/ui/` | Controls, dialogs, banners, charts (columns with keyboard tooltips and a table view, bar lists, meters) |
| `src/pages/account`, `src/pages/admin` | One file per page |
| `src/styles/app.css` | Tokens from the app's palette (`apps/mobile/src/theme/tokens.ts`) and every component style |

Types come from `@studify/shared` (`schemas/edge-dashboard.ts`) as type-only imports; a test keeps it that way,
because the image builds the dashboard without that package's source.
