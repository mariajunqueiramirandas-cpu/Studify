# studify.vendua.com.br

Static site for the public link domain (D-05): the landing page for shared links (SOC-09.4,
S-EXT-03) and the Android App Links verification file. No build step; deploy `public/`.

| Path | Serves |
|---|---|
| `/` | Short "what is Studify" page with the APK button |
| `/c/{code}`, `/i/{code}`, `/q/{token}`, `/b/{pin}` | `link.html`: code in big letters + Copiar, "Já tenho o app: abrir" (custom scheme), APK button, install help, iPhone note |
| `/.well-known/assetlinks.json` | Android App Links verification |

When the app is installed and the links are verified, Android opens the app directly and this
page never shows.

## Before going live
1. **Rewrites:** every `/c|i|q|b/*` path must serve `link.html` with status 200. `public/_redirects`
   covers Netlify and Cloudflare Pages; `vercel.json` covers Vercel.
2. **assetlinks.json:** replace both placeholders with the SHA-256 signing-certificate fingerprints
   (`npx eas-cli@latest credentials` → Android → the build profile's keystore). It must be served as
   `application/json` over HTTPS with no redirect.
3. **APK link:** set `apkUrl` in `public/config.js` to the EAS internal-distribution install link.
4. **Not here yet:** `/privacidade` (SP-13 privacy notice, needs legal review) and `/ajuda`; the app
   links to both.
