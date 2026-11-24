# VVS Smilez — Phase 3A Engineering Record (Voice & Staging)
Date: 2026-11-23. **Source-only implementation, no live worker restart, deployment, Git push, paid voice call, or calendar write.**

## Verified starting state

- Node 24.22.2 on the connected Windows machine.
- LiveKit native probe `GET http://127.0.0.1:8081/` returned **HTTP 200** while port 8081 was owned by `node.exe` PID 12052. Health endpoint is evidence of the agent service's native health report, not verified SIP/call capacity.
- Voice source branch `sync/private-663-20261122` contains valuable uncommitted Phase 1 and Phase 2 changes.
- Its `origin` still points at `https://github.com/andygdz93-dev/spanish-ai-receptionist.git`. Connected GitHub account reported `andygdz663`, but the installed-repository searches returned no matching repositories, and searching the intended `andygdz663/spanish-ai-receptionist` yielded a permission/not-found error. **Never push or change origin without identifying/approving the private source-of-truth.**
- HQ is not a Git repository; its persistent `local-data` directory was absent at audit.

## Changes implemented

1. `src/operational-producer.ts`: a 200 or 202 status is no longer sufficient. A JSON receipt must identify the exact event UUID and status `accepted` or `duplicate`. Otherwise the event is retried instead of being falsely marked delivered.
2. `src/operational-outbox.ts`: SQL-backed operator diagnostics for pending, retry attempts, dead-letter, dependency-blocked, oldest pending, and most recent delivery. No fabricated counts; all derived from persisted SQLite.
3. `src/telemetry-health.ts`: an **opt-in** loopback native health probe plus signed report of actual outbox state. The signal says `healthy` only for native HTTP 200; failures report a signed `unreachable` *probe result*, not a claim the worker is definitely offline. HQ receipt authorization remains required.
4. `src/staging-profile.ts`: fail-closed staging guard. Requires `VVS_RUNTIME_PROFILE=staging`, `VVS_STAGING_CREDENTIALS_CONFIRMED=yes`, `DENTAL_DEMO_MODE=yes`, `DENTAL_BOOKINGS_ENABLED=no`, an explicit telemetry on/off flag, and **no inherited Google booking credentials**. For telemetry enabled, it requires explicit HQ endpoint, pinned identity/secret and absolute outbox path outside the repository.
5. `src/main.ts`: staging loads `.env.staging.local` rather than `.env.local`, validates staging before launching. Normal development behavior is preserved. The telemetry producer itself remains disabled unless separately enabled; running worker was not restarted.
6. `src/staging-supervisor.ts`: manually run Node process supervisor. **Default command only validates configuration** and starts nothing. `--run --drainer` or `--run --monitor` can supervise one opted-in component with restart attempts. It has no Windows service installer and was not registered for autostart.
7. `scripts/staging-supervisor.ps1`: optional PowerShell supervisor source. **Execution is blocked by this machine's PowerShell execution policy. The policy was not modified or bypassed.** Use the tested Node supervisor after approval instead.
8. `.env.staging.example` contains **no secret values**. `.env.staging.local` and the local SQLite outbox are excluded from Git and Docker contexts.
9. `src/operational-restart.test.ts` actually launches an isolated Node child that terminates abruptly while holding a SQLite event lease; a second process opens the same WAL and resumes it without accepting duplicate acknowledgements.
10. Other tests verify outbox diagnostics, response forgery/misrouting, staging policy and mocked health reporting.

No production passwords, live clinic IDs, API keys, OAuth files, transcripts or caller data were stored or included in documentation.

## Staging launch sequence — NOT executed against the running worker

All stage credentials must be provisioned securely via the launching service's protected environment or Windows Credential Manager. Never type or save them into project files, logs, Git, commands in chat, browser settings or room metadata. Only use a **dedicated, verified staging LiveKit project**, not inherited production credentials. Confirm worker account/endpoint/project identity independently.

Set nonsecret staging flags in a protected launch context:

```powershell
$env:VVS_RUNTIME_PROFILE = 'staging'
$env:VVS_STAGING_CREDENTIALS_CONFIRMED = 'yes'  # only after a manual review
$env:DENTAL_DEMO_MODE = 'yes'
$env:DENTAL_BOOKINGS_ENABLED = 'no'
$env:HQ_TELEMETRY_PRODUCER_ENABLED = 'no'  # keep disabled until separately approved
node src/staging-preflight.ts
node src/staging-supervisor.ts --validate
```

For **future, approved** telemetry staging only, provision `HQ_TELEMETRY_PRODUCER_ENABLED=yes` with the same pinned clinic UUID, worker ID and random secret as the **disposable or staging** HQ receiver; set `HQ_TELEMETRY_ENDPOINT` to the reviewed local/HTTPS receiver and `HQ_TELEMETRY_OUTBOX_PATH` to a private absolute persistent `.sqlite` location **outside both Git repositories**. Do not use the default local repo path. Then a human can manually start:

```powershell
node src/staging-supervisor.ts --run --drainer
# In another explicitly approved session:
node src/staging-supervisor.ts --run --monitor
```

This is manual staging supervision, **not automatic recovery after Windows reboot**. Registering a Windows Service or scheduled task requires further explicit approval and controlled credentials, startup/stop testing and storage backups. Stopping the supervisor does not delete queued events.

## Evidence and failure injection

| Scenario | Evidence |
|---|---|
| HQ absent at start, then recovered | `tests/voice-producer-contract.mjs` in HQ; voice lifecycle offline test |
| Sender exits with an unacknowledged lease | `src/operational-restart.test.ts` (real child process exit) |
| Duplicate event / altered same UUID | Voice outbox tests and HQ `telemetry-http.integration.test.ts` |
| Terminal arriving without start | HQ HTTP integration test |
| Stale heartbeat | HQ heartbeat-state unit tests and HTTP integration |
| Network failure / unavailable receiver | Voice producer tests |
| Fake HTTP 200 acknowledgement | Voice producer tests; retained for retry |
| Invalid signed request / stale timestamp | HQ HTTP integration test |
| Cross-clinic forgery / replay nonce | HQ HTTP integration test |
| Dead-letter dependency blocking | Voice outbox diagnostics tests |
| Queue reopened after restart | Voice SQLite tests and cross-project contract |
| Manual Node supervisor drains mock queue | `src/staging-supervisor.integration.test.ts` (fake local receiver) |

All tests use disposable databases and synthetic credentials. The existing inference safety test suite is run with spending flags disabled; it must **fail closed before provider requests**.

## Recovery and rollback

- Never run `git restore .` or reset the working tree: voice contains uncommitted Phase 1/2 changes and its origin is not verified.
- Before enabling staging, stop relevant processes and back up the **entire** SQLite outbox (`.sqlite`, `-wal`, `-shm`) to a private, access-controlled location. A half-copied WAL snapshot is not sufficient. Do not put event DBs into source snapshots.
- Staging rollback: disable `HQ_TELEMETRY_PRODUCER_ENABLED`, stop manually launched supervisors, and revert specifically reviewed Phase 3A source changes once a proper private Git baseline is established. Do not affect the currently running voice process.
- HQ schema `0005_heartbeat_monitoring` is additive with no down migration. For any future persistent HQ database, stop HQ, create an offline full database backup, and restore the backup if rollback is needed.
- Retention, dead-letter reconciliation, monitored-supervisor recovery across Windows reboot, secret rotation, hosted authentication, and multi-tenant credentials are **not** production ready.

## Approval blockers

1. Identify and approve the private Git repository; the currently configured origin is a different owner. Do not push.
2. Establish a safe HQ source-control baseline; HQ is not yet tracked by Git.
3. Review stage-only credentials, clinic identity and private persistent storage.
4. Approve any change to running LiveKit worker processes, new automatic Windows startup, or hosted deployment.
5. Approve a controlled paid call only after the above, to correlate actual LiveKit job/call and HQ history.
6. Keep real Google bookings disabled until calendar write reconciliation and authorization are separately completed.

**Phase 3B recommendation:** resolve source control, review/activate isolated staging with manual supervision, prove restart and heartbeat evidence in that **actual** staging environment; only then consider a controlled paid call and production migration.

## Final verification — 2026-11-23

- Voice `vitest run --fileParallelism=false`: **108/108 passed** in 20 test files; all provider-spending authorization flags explicitly disabled.
- Voice `tsc --noEmit`, focused ESLint and `git diff --check`: **passed**. LF-to-CRLF Git warnings on Windows are non-fatal.
- HQ `vitest run`: **47/47 passed** in 13 test files; HQ TypeScript and UI JavaScript syntax checks passed.
- HQ Edge tests `tests/phase2-telemetry-browser.mjs` and `tests/phase2e-browser.mjs`: **both passed**. Cross-project disposable `tests/voice-producer-contract.mjs`: **passed**.
- Controlled Node supervisor integration test with a synthetic event, temporary WAL and fake HTTP receiver: **passed**, no auto-start registration.
- Native LiveKit health read-only check: **HTTP 200**, running `node.exe` PID 12052 on port 8081. No HQ port 8787 listener, no persistent HQ `local-data`, no default voice outbox.
- PowerShell script parser accepted the script source, but PowerShell execution policy **blocked invocation**. Policy left unchanged. The Node supervisor validation and mocked run were tested instead.
- Local selected-source-only checkpoints, outside the repositories: `..\\_source_snapshots\\VVS-Phase3A-voice-20261123-012225-8398c3.zip` and `..\\_source_snapshots\\VVS-Phase3A-hq-20261123-012225-332868.zip`. These are **post-change snapshots**, not substitutes for a pre-migration database backup or verified private Git history.
