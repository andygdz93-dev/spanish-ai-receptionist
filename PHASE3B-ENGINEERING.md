# VVS Smilez — Phase 3B Voice Engineering Execution
Date: 2026-11-23. Status: **source hardening and synthetic verification; real staging and calls NOT activated**.

## Current architecture and changes

Existing LiveKit worker remains on its current running code, native HTTP port 8081. Phase 3B modifies only on-disk code and disposable test fixtures.

- `src/staging-health-target.ts` (new): validates an explicit loopback `STAGING_NATIVE_HEALTH_URL` and `STAGING_NATIVE_HEALTH_EXPECTED_PID`, forbids port 8081 and admin port 8787, enforces Windows node.exe ownership of the exact 127.0.0.1 listening port using read-only `Get-NetTCPConnection` + `Get-Process`. The caller verifies ownership both before and after the probe. Unexpected PID, missing listener, or unavailable OS inspection aborts heartbeat rather than inventing a health claim.
- `src/telemetry-health.ts`: no implicit default port 8081. The monitor validates staging profile before it reads credentials or sends a signed heartbeat. Reporter requires an explicit stage target, checks actual listener ownership, fetches the native-shaped health URL, rechecks ownership, and signs the resulting health+SQLite-queue snapshot with the existing HMAC protocol. An unrelated 200 HTTP response from HQ never counts as an accepted receipt.
- `src/main.ts`: when `VVS_RUNTIME_PROFILE=staging`, `ServerOptions` now uses `host: '127.0.0.1'` and the dedicated health-target port. In normal development mode the existing options remain unchanged. The installed `@livekit/agents/dist/worker.d.ts` was inspected and documents `host` and `port` as supported ServerOptions constructor properties. A separate real stage process has not been launched.
- `readStagingWorkerServerConfig` requires an explicitly reviewed `STAGING_LIVEKIT_URL` exactly equal to `LIVEKIT_URL`, and requires a `wss:` connection or loopback `ws:`. A matched URL/checkbox is not proof the LiveKit account belongs to a separate project; human credential review is still mandatory.
- `src/staging-profile.ts`: staged telemetry receiver requires explicit loopback port different from 8081/8787, along with existing demo-only, credential, identity and external persistent-outbox requirements.
- `src/telemetry-drain.ts`: direct staging invocations validate stage config instead of relying solely on the supervisor.
- `src/staging-supervisor.ts`: manually invoked monitor refuses missing expected PID/URL before spawning; child subprocess receives the explicitly verified environment. No Windows Task Scheduler or service installation.
- `.env.staging.example` includes only nonsecret configuration hints with stage worker URL/health port and PID information.
- Added/extended unit and integration tests around authorization gates, wrong endpoint, mismatched PID, changed PID during a probe, signed queue reporting, staging server options and supervisor checks.

## Staging environment — future, separately approved activation

Do not run these instructions until explicit separate approval, a dedicated staging LiveKit project/credentials are reviewed, and the private Git source-of-truth is resolved. The staging worker must use a **different project from the existing running worker**. Never copy inherited production credentials or real Google refresh tokens.

Staging voice baseline: `VVS_RUNTIME_PROFILE=staging`, `VVS_STAGING_CREDENTIALS_CONFIRMED=yes` only after review, `DENTAL_DEMO_MODE=yes`, `DENTAL_BOOKINGS_ENABLED=no`, `STAGING_LIVEKIT_URL` exactly matching the approved stage `LIVEKIT_URL`, `STAGING_NATIVE_HEALTH_URL=http://127.0.0.1:18081/` (if port 18081 is unused), and a distinct stage worker identity.

Staging reporter must then be launched with `STAGING_NATIVE_HEALTH_EXPECTED_PID` equal to the actual approved **staging** node.exe PID after verifying that it owns the dedicated 127.0.0.1 port. Never use the PID of the existing worker on 8081. If the stage worker restarts under a new PID, reporting correctly refuses until identity is reverified.

Stage telemetry requires: `HQ_TELEMETRY_PRODUCER_ENABLED=yes`, `HQ_TELEMETRY_BUSINESS_ID` (approved test clinic UUID), `HQ_TELEMETRY_WORKER_ID` (pinned stage ID), protected `HQ_TELEMETRY_SIGNING_SECRET` (at least 32 bytes), `HQ_TELEMETRY_ENDPOINT=http://127.0.0.1:18788/api/internal/telemetry`, and private absolute `HQ_TELEMETRY_OUTBOX_PATH` outside Git. The HQ stage guard must separately approve matching identities and URL.

Do not save tokens or keys in source files, documentation, browser storage, chat logs, or PowerShell history. Provision secrets through a protected process environment or controlled Windows secret store. Stage monitor and drainer remain manually opt-in; Windows reboot autostart is not implemented.

## Tests and evidence

- Native Windows OS-port inspector was exercised against an actual disposable **Node HTTP server** listening on 127.0.0.1 with an ephemeral port. PID matched the child process, and the health reporter sent a signed mocked HQ receipt after both ownership checks. **This was not an actual LiveKit worker and did not consume inference.**
- Unit tests cover wrong URL/8081, missing or mismatched PID, TOCTOU/PID changes, missing stage credentials, staging worker URL mismatch, failed probes, queue and HMAC contract.
- Separate fake LiveKit job → SQLite outbox → retry → signed disposable HQ staging receiver → authenticated history cross-project test passed, but all LiveKit context was mocked.
- Original Phase 3A crash/restart and retry tests remain part of the full suite.
- Operator dashboard shows evidence age and the reported native-probe outcome from authenticated stored receipts; no fabricated call metrics.

## Source control, rollback and operational boundaries

- GitHub account `andygdz663` cannot access intended private `andygdz663/spanish-ai-receptionist` (404, ambiguous missing vs denied). Existing voice `origin` is a **public** repository under `andygdz93-dev`. No remotes modified and no pushes made.
- Original voice branch `sync/private-663-20261122` contains earlier uncommitted Phase 2/3A work. Do not reset or discard changes. Existing Phase 3B current-source and original-history recovery bundles were verified in the previous checkpoint under `..\\_source_snapshots`. A refreshed post-implementation snapshot should be verified before any future source migration.
- Rollback source safely only from separate reviewed files/checkpoints, without overwriting the running worker; no staged process or persistent database was changed. In a future approved deployment, fully stop staging, back up complete SQLite database and WAL and HQ PGlite directory before any migration/rollback.
- No real patient data, recordings, transcripts or calendar writes were generated in these tests.
- **Remaining blockers:** private GitHub repository identity/permissions; verified isolated LiveKit stage project and keys; human approval to start any stage worker or monitoring process; review of production authorization, multi-tenant identity, retention/alerts, and an explicitly approved later real call.

**Readiness decision: BLOCKED — REQUIREMENTS NOT MET for actual staging activation. Synthetic/local code can be fully tested without crossing that gate.**

## Final Phase 3B verification checkpoint — 2026-11-23

- Voice full `vitest run --fileParallelism=false`: **117/117 passed**, 22 test files, exit 0; spending-cap flags explicitly disabled. TypeScript `tsc --noEmit`, focused ESLint on all operational/staging/telemetry modules and `git diff --check`: **passed** (non-fatal Git LF/CRLF warnings only).
- HQ full `vitest run`: **50/50 passed**, 14 test files, exit 0; HQ `tsc --noEmit` and browser JavaScript syntax passed.
- Both Microsoft Edge browser tests **passed**, including stored native probe and server receipt age. The first run of the expanded browser test exposed an incorrectly escaped assertion, corrected and rerun successfully. No dashboard defect was observed.
- Disposable full cross-project staging contract **passed**: mocked LiveKit job, persisted outbox, HQ offline/retry, HMAC, pinned clinic/worker identity and reviewed synthetic staging flags, signed mocked health PID and authenticated history. No actual voice call.
- Windows native health OS identity test **passed** against a separate disposable Node HTTP child; no LiveKit worker started. Stage listener uses a dedicated 127.0.0.1 host/port supported by installed `@livekit/agents` ServerOptions typings and implementation. Staging CLI overrides of project URL/API key/API secret/worker token are now rejected before SDK startup, preventing bypass through `--url`.
- No persistent staging outbox or HQ database was created. Actual staging worker credentials and its PID/health port are not yet available, so **actual stage heartbeat verification remains BLOCKED**. No claims of real-call or production readiness.

**Source control:** connected GitHub user `andygdz663` could not access intended `andygdz663/spanish-ai-receptionist` (404); existing voice origin `andygdz93-dev/spanish-ai-receptionist` confirmed public. Never push to the public origin. No remotes, real workers, service registrations, phone calls, paid inference, or real bookings changed during Phase 3B.
