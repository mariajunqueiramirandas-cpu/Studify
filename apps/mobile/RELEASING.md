# Android releases

`.github/workflows/android-release.yml` builds a signed release APK on every push to `main` that changes the
app (`apps/mobile`, `packages/shared`, or the root dependency files; the list is the workflow's `paths` filter) and
on manual runs from `main`, then publishes it as a GitHub Release. Server-only pushes build nothing. The build runs on a GitHub-hosted runner: `expo prebuild`
generates `android/`, Gradle builds the APK, and the APK is re-signed with the release key. EAS is not used for
this path.

Release outputs:

- Tag and release name: `v<version>-build.<run number>` and `Studify <version> (build <run number>)`
- APK asset: `studify-<version>-build<run number>.apk`, marked as the latest release
- applicationId: `com.studify.app` (production environment)
- Job summary: release link, APK SHA-256, and the signing certificate SHA-256 for `assetlinks.json`

## One-time setup

### 1. Create the release keystore

Run this once, on a trusted machine:

```bash
keytool -genkeypair -v -storetype PKCS12 -keystore studify-release.keystore -alias studify -keyalg RSA -keysize 2048 -validity 10000
```

Use the same password for the keystore and the key. PKCS12 stores one password, and keytool warns if they differ.

### 2. Back up the keystore before anything else

Android installs an update only over an app signed with the same key. If the keystore is lost, every installed
copy has to be uninstalled and reinstalled, which deletes local data, and the App Links fingerprint in
`assetlinks.json` has to be replaced. Keep the `.keystore` file and both passwords in a password manager, plus
at least one offline copy. Never commit the keystore. `apps/mobile/.gitignore` ignores `*.keystore`.

### 3. Store the keystore in GitHub

Encode the keystore and save it as a repository secret (`base64 -w0` is GNU only; on macOS use `base64 < file | tr -d '\n'`):

```bash
base64 -w0 studify-release.keystore > studify-release.keystore.b64
gh secret set ANDROID_KEYSTORE_BASE64 --repo <owner>/<repo> < studify-release.keystore.b64
rm studify-release.keystore.b64
```

Add the other signing secrets the same way (`gh secret set NAME --repo <owner>/<repo>` prompts for the value):
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`studify` if you used the command above), and `ANDROID_KEY_PASSWORD`.

The workflow stops before building if any of the four signing secrets is missing. It never publishes a
debug-signed APK.

### 4. Set the repository variables and secrets

Settings > Secrets and variables > Actions.

| Name | Kind | Required | Used for |
| --- | --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Secret | yes | Base64 of `studify-release.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | Secret | yes | Keystore password |
| `ANDROID_KEY_ALIAS` | Secret | yes | Key alias (`studify`) |
| `ANDROID_KEY_PASSWORD` | Secret | yes | Key password (same as the keystore password for PKCS12) |
| `GOOGLE_SERVICES_JSON_BASE64` | Secret | for remote push | Base64 of the Firebase `google-services.json` (step 6). Without it the build gets no push token. |
| `EXPO_PUBLIC_SUPABASE_URL` | Variable | yes | Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Variable | yes | Supabase publishable key (`sb_publishable_...`), or the legacy anon key until it is turned off. Public by design; RLS protects the data. |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | Variable | recommended | Google sign-in web client id (empty disables Google sign-in) |
| `EXPO_PUBLIC_EAS_PROJECT_ID` | Variable | for remote push | The Expo project the push tokens belong to (step 6); also enables the expo-updates URL. |
| `EXPO_PUBLIC_BASE_URL` | Variable | no | Defaults to `https://studify.vendua.com.br` |
| `EXPO_PUBLIC_API_URL` | Variable | no | Defaults to `https://studify.vendua.com.br/api`. The app does not read it yet. |
| `APP_VERSION_SUFFIX` | Variable | no | Appended to the version name, for example `-beta.1` |

Every `EXPO_PUBLIC_*` value is compiled into the APK, so only public values belong in variables. Never put
service-role keys or Anthropic keys in an `EXPO_PUBLIC_*` variable.

### 5. Put the release fingerprint into assetlinks.json

Android App Links check `https://studify.vendua.com.br/.well-known/assetlinks.json` against the signing
certificate of the installed app. The job summary of each release prints the certificate's SHA-256 fingerprint
in the required form (uppercase, colon-separated). The same value comes from:

```bash
keytool -list -v -keystore studify-release.keystore -alias studify
```

Copy the `SHA256:` value into `apps/site/public/.well-known/assetlinks.json`, in the entry with
`"package_name": "com.studify.app"`, replacing `REPLACE_WITH_PRODUCTION_SHA256_FROM_eas_credentials`. Deploy the
site so the file is live before users install a build, then check that the URL above returns the JSON.
If the key is ever rotated, list both fingerprints in `sha256_cert_fingerprints` during the transition.

### 6. Remote push (optional, recommended)

Without this, the app still shows its local reminders (reviews with the next card, the day's plan, the exam
eve, the streak), mirrors live progress while it is open, and keeps the Central de notificações in step. With
it, server pushes (material ready, Turma, battles, live progress while the app is closed) reach the phone and
are drawn by the `studify-notify` module.

1. Create a Firebase project and add an Android app with the package `com.studify.app`. Download its
   `google-services.json` and store it as the secret: `base64 -w0 google-services.json` → `GOOGLE_SERVICES_JSON_BASE64`.
   The workflow writes it to the runner and sets `GOOGLE_SERVICES_FILE`, which `app.config.ts` passes to
   `android.googleServicesFile`. The file is git-ignored; never commit it.
2. Create an Expo project (`npx eas-cli@latest init` in `apps/mobile`) and set its id as `EXPO_PUBLIC_EAS_PROJECT_ID`.
3. In Firebase, create a service-account key for FCM HTTP v1 and upload it to the Expo project
   (`npx eas-cli@latest credentials` → Android → Google Service Account → FCM V1). Expo uses it to deliver.
4. Give the worker an Expo access token with push permission as `EXPO_ACCESS_TOKEN` (see `packages/server-tasks/.env.example`).

Check: on a release build, sign in, allow notifications, and look for a row in `push_tokens` for your user.
Perfil → Notificações → Ver exemplos sends every layout to the shade without the server.

### 7. Google sign-in

The account picker opening proves only `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` is set. After the pick, Google checks
that an **Android** OAuth client in the same Google Cloud project matches the installed app's package and
signing key. Without it the app gets `DEVELOPER_ERROR` (code 10) and says Google sign-in is not available yet.

1. In the Google Cloud console (the Firebase project from step 6 if you use one), open APIs & Services →
   Credentials. Configure the OAuth consent screen if it asks, and publish it (or add your testers) so
   accounts outside your own can sign in.
2. Create an OAuth client of type **Web application**. Its client id is `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`.
3. Create an OAuth client of type **Android** with package `com.studify.app` and the release key's **SHA-1**.
   The job summary of each release prints it; the same value comes from
   `keytool -list -v -keystore studify-release.keystore -alias studify` (the `SHA1:` line). Add a second
   Android client with the debug key's SHA-1 if you also sign in from local debug builds.
4. In Supabase, Authentication → Sign In / Providers → Google: enable it and enter the web client id and its
   secret. Supabase rejects ID tokens issued to any client id it does not list there.

Changes in Google Cloud can take a few minutes to apply; the APK does not need a rebuild.

### 8. E-mail sign-in

The app asks for the 6-digit code from the e-mail. Supabase generates the code and renders the e-mail from
`supabase/templates`; Resend delivers it over SMTP. Supabase's default templates carry only a link, and its
built-in sender allows 2 e-mails per hour, so both must be replaced before real users sign in.

1. In Resend, Domains → Add Domain: `auto.vendua.com.br`. Add the DNS records it lists (SPF, DKIM, and the MX
   for bounces) at the DNS provider and wait until the domain shows **Verified**.
2. In Resend, API Keys → Create API Key with **Sending access**, limited to that domain, used only by Supabase.
   It can send from that domain and nothing else, and revoking it touches nothing else. Create a second key the same
   way for the API (`RESEND_API_KEY` in Dokploy).
3. From the repository root, push the templates, the SMTP sender and the e-mail rate limit (the
   `[remotes.production]` block of `supabase/config.toml`):
   ```bash
   supabase login
   supabase link --project-ref pwigsfpkyxdtorxvwpnt
   RESEND_API_KEY=re_... supabase config push   # the Supabase key from step 2
   ```
   `config push` shows the changes and asks before applying them. Without the CLI, set the same values in the
   dashboard: Authentication → Emails → SMTP Settings (host `smtp.resend.com`, port `465`, user `resend`,
   password the API key, sender `studify@auto.vendua.com.br`, name `Studify`), and paste each template
   under Authentication → Email Templates (Confirm signup and Magic Link) with the subject from `config.toml`.
4. Sign in with a fresh address: the e-mail comes from `studify@auto.vendua.com.br`, in Portuguese, with
   the code in the subject and in the body. Resend → Emails lists each delivery.

The API sends the guardian verification mail through Resend's REST API with its own key (`RESEND_API_KEY` in the
API environment, `.env.example`).

## Build speed

The release APK contains `arm64-v8a` only (`ANDROID_ABIS` in the workflow), because each ABI compiles every native
library again. It does not install on 32-bit phones (`armeabi-v7a`, including Android Go phones with a 32-bit system)
or on x86 emulators; add those ABIs to `ANDROID_ABIS`, comma-separated, if one of them is needed. The workflow also gives Gradle more memory,
turns on the Gradle build cache, keeps compiled C++ between runs with ccache, and skips release lint and PNG crunching.
The first run after a cache reset is the slowest; later runs reuse the caches written by `main`.

## Versioning

- **Version name**: `version` in `app.config.ts` (`0.1.0`), plus `APP_VERSION_SUFFIX` if the variable is set.
- **versionCode**: the workflow sets `ANDROID_VERSION_CODE = github.run_number + 100`. Android refuses to install
  an update with a lower versionCode, and run numbers only go up. The offset (`ANDROID_VERSION_CODE_OFFSET` in the
  workflow) keeps the codes above any build made before this workflow existed. Raise the offset if an older build
  ever has a higher code.
- `app.config.ts` reads `ANDROID_VERSION_CODE` (an integer from 1 to 2100000000) and `APP_VERSION_SUFFIX`. Without
  them, the versionCode stays at Expo's default.

To run the workflow manually: Actions > Android release > Run workflow, on `main`. Runs on other branches stop before
building, unless **dry_run** is ticked: a dry run builds and signs the APK on any branch and attaches it to the run as
an artifact (kept 7 days) without publishing a release. Use it to test release-build changes before merging.
Re-running an old run fails if its release already exists. Push a new commit or start a new run instead.

## Local build (optional)

The release workflow is the only place the release key is used. A local build is signed with the Expo template's
debug key, so use it only for testing.

```bash
cd apps/mobile
EXPO_PUBLIC_ENV=production ANDROID_VERSION_CODE=101 npx expo prebuild --platform android --no-install --clean
cd android && ./gradlew assembleRelease
```

This needs JDK 17 and the Android SDK packages platform 37, build-tools 37.0.0 and NDK 27.1.12297006. The `android/`
and `ios/` directories are generated (continuous native generation), and `apps/mobile/.gitignore` ignores them.
Do not edit them by hand.

## EAS (optional)

No workflow builds with EAS: the release workflow builds on the GitHub runner, and a dry run (above) tests a branch.
EAS builds (`npx eas-cli@latest build --profile preview --platform android`) are optional and run by hand, with two
things to keep in mind:

- EAS signs with its own credentials. An EAS build can update a GitHub release build only if both use the same key.
  Upload this keystore to EAS (`npx eas-cli@latest credentials`, Android, production profile), or accept that EAS
  builds and GitHub builds cannot install over each other.
- EAS production uses `autoIncrement` with its own remote versionCode. Keep it above the GitHub run number + 100,
  or EAS builds will be refused as downgrades. Preview and development builds use the `.preview` and `.development`
  package suffixes, so they install side by side with production.
