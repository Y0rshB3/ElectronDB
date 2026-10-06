# ElectronDB

Private desktop MySQL client (macOS first, also Windows/Linux) compatible with Navicat data (connections, batch jobs, `.nb3` backups). Spanish UI, English code and comments. Formerly called **Navidog**; the repo folder still uses that name.

## Commands

- `npm run dev` — Electron + Vite dev mode
- `npm run check` — lint + typecheck + unit tests (must pass before finishing any task)
- `npm test` / `npm run test:watch` — Vitest (projects: `node`, `web`)
- `npm run test:integration` — needs `ELECTRONDB_TEST_MYSQL_URL=mysql://user:pass@host:port/db` (skipped otherwise). The macOS keychain test also needs `ELECTRONDB_TEST_KEYCHAIN_DIR=<scratch dir>`: it creates a throwaway keychain there and deletes it.
- `npm run build` — production bundle to `out/`; `npm run dist` — installers in `release/`
- Smoke test after a build: `ELECTRONDB_USER_DATA=<tmp dir> ELECTRONDB_SMOKE=1 ELECTRONDB_PLAIN_SECRETS=1 npx electron .` (exit 0 = renderer loaded, IPC answered). Always use `ELECTRONDB_USER_DATA` for manual runs so the real profile and LaunchAgents are untouched.

## Layout

- `src/shared/` — domain types (`types.ts`) and the typed IPC contract (`ipc.ts`). **The IPC map is the only API between renderer and main.** Add a channel there first, then implement `src/main/ipc/<area>.ts`, then use it from the renderer through `window.electronDB.invoke`.
- `src/main/` — Electron main. Modules: `navicat/` (import), `mysql/` (connections, introspection, queries), `backup/` (.nb3 read/write/restore), `automation/` (jobs, scheduler, launchd), `credentials/`, `storage/` (JSON repos in userData), `migration/` (one-time Navidog -> ElectronDB profile and secret migration), `updates/` (checks GitHub Releases for a newer version: notify only, never downloads or installs; network calls stay in main via `net.fetch`; `app:openExternal` only allows `https://github.com/Y0rshB3/ElectronDB/releases/...`).
- `src/preload/` — contextBridge only, no logic.
- `src/renderer/` — Vue 3 + Vuetify 3 + Pinia. Views under `src/views`, reusable components under `src/components`, stores under `src/stores`, `src/api.ts` wraps `window.electronDB`.
- `tests/fixtures/navicat/` — anonymised Navicat files + a synthetic `.nb3`. Never add real hosts, users or data.
- `docs/navicat-storage.md` — verified Navicat formats. Read it before touching import/backup code.

## Naming and the Navidog legacy

- Product name and identifiers live in `src/main/brand.ts`; env switches are read with `envVar()` (`src/main/env.ts`): `ELECTRONDB_<NAME>`, with the old `NAVIDOG_<NAME>` accepted as an undocumented fallback.
- Keep "Navidog" only where it identifies legacy data: `src/main/migration/`, the `LEGACY_*` constants (profile folder, "Navidog Safe Storage" keychain item, `dev.y0rshb3.navidog.job.*` launchd labels, `navidog.queries.*` localStorage keys), the env fallback, and the throwaway test MySQL credentials (`root`/`navidog`, db `navidog_test`).
- CSS tokens and utility classes keep the internal `--nd-*` / `nd-` prefix on purpose (it stands for the old name); do not rename them.
- Migration runs once per profile: `runProfileMigration` before app `ready` (copies `<appData>/Navidog` into `<appData>/ElectronDB`, never overwriting, writes `migrated-from-navidog.json`) and `runSecretMigration` right after the context (re-encrypts `credentials.json`; on macOS reads the old safeStorage key with `security`). A scratch profile (`ELECTRONDB_USER_DATA`) skips it.
- Test-only switches, never for real use: `ELECTRONDB_LEGACY_USER_DATA=<dir>` migrates from that folder even into a scratch profile; `ELECTRONDB_LEGACY_KEYCHAIN=<file>` reads "Navidog Safe Storage" from that keychain file instead of the login keychain.

## Conventions

- Tests live next to code as `*.test.ts`; node-side tests must not import `electron`.
- Never log query data, passwords or backup contents. Secrets go through `CredentialStore` only.
- Any operation that writes to a connection whose environment requires typed confirmation (`requiresTypedConfirm` in `src/shared/typedConfirm.ts`: always `production`, plus the environments listed in `AppSettings.typedConfirmEnvironments`) must require explicit confirmation: the UI dialog (`useConfirm().confirmDestructive`) and then `confirmProduction: true` in the IPC call (`WriteOptions`). Main enforces it in `src/main/ipc/productionGuard.ts`.
- Errors thrown from IPC handlers surface to the user as their `message`: write actionable messages.
