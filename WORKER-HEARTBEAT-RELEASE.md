# Production worker heartbeat release — 2026-11-24

## Behavior

- The existing `node src/main.ts start` entrypoint starts one heartbeat loop in the worker parent process. Staging continues to use its separate health reporter.
- Reuses `HQ_TELEMETRY_PRODUCER_ENABLED`, business/worker identity, signing secret, receiver endpoint, and outbox path. No additional environment setting is required.
- Sends an immediate probe and repeats approximately every 30 seconds, with at most one operation in flight. A probe sends nothing to HQ until this process owns the native IPv4 health listener on port 8081 and that endpoint returns HTTP 200. Ownership is checked again after the HTTP probe.
- Uses the existing `worker_heartbeat` receiver shape, `source: livekit`, `health: healthy`, and aggregate outbox diagnostics. Signs the exact bytes with the existing HMAC helper, fresh timestamp and nonce. Delivery requires HTTP 200/202 plus an exact matching event ID and `accepted`/`duplicate` receipt.
- Heartbeats are current health observations and are not queued for historical replay. A failed heartbeat is replaced by the next fresh probe. Call lifecycle events retain their existing durable SQLite WAL queue, retries, ordering, and dead letters without changes.
- No transcripts, phone numbers, room names, patient details, or booking content are included. SIGINT/SIGTERM stops scheduling and aborts in-flight heartbeat requests before the SDK drains the worker.
- Windows ownership uses numeric OS listener/PID data. Linux uses `/proc/net/tcp` and the current process's socket descriptors. Missing or ambiguous evidence suppresses healthy events. Other platforms fail closed.

## Test fixes

- Gemma preflight and blocked evaluation no longer import the native LiveKit SDK. It is loaded only after existing credential, budget, and source checks pass. Tests explicitly clear both budget-approval environment variables.
- Staging listener checks use asynchronous `netstat` and `tasklist` instead of starting PowerShell/CIM for every check. The authorized PID, Node process identity, and checks before and after the health probe remain required.
- Windows Vitest files run serially to avoid Google API dependency loading in competing workers delaying the cross-process calendar test. Test deadlines and booking implementation are unchanged.

## Verification

- Full worker suite after the existing-process observer addition: **28 files, 166/166 tests passed**, default command `node node_modules/vitest/vitest.mjs --run`, 32.31 seconds on the configured Windows host.
- TypeScript `--noEmit` and ESLint on changed source/test files passed. Changed files are checked with the repository's Prettier configuration.
- Scheduler tests cover 30-second cadence, no overlapping sends, stop/abort, and shutdown-listener cleanup. Other tests cover signed minimal payloads, exact receiver receipts, unavailable/unhealthy probes, missing/changing ownership, and actual OS ownership of disposable localhost listeners. Staging integration also proves a child process's listener is not attributed to the parent.
- Configured outbox: `%LOCALAPPDATA%\VVS-Smilez-HQ\telemetry-outbox.sqlite`, outside the checkout. Existing file is WAL mode and read-only SQLite `quick_check` returns `ok`. A disposable sibling WAL database was successfully written, closed, and reopened; the diagnostic scratch directory was removed. No live queue contents were modified by that check.
- No live calls, routing changes, booking changes, or production worker registration were performed. No HQ code or database migration is required.

## Pending production activation

The prior automatic approval review rejected starting the production worker because registration can receive real incoming calls. This release is prepared locally; production activation and the resulting dashboard transition remain unverified.

After explicit approval, inspect whether an existing worker owns port 8081 before launching anything. Never run an additional competing `my-agent` worker or force-kill an active call. Use a controlled drain/restart of the existing worker, or the existing start command if no worker is running, keeping the current credentials, route configuration, and outbox path. A different host or container requires its own persistent writable outbox location and OS ownership verification.

Observe at least two accepted heartbeat receipts roughly 30 seconds apart, a native health HTTP 200, and the authenticated Dentista Florencia HQ card changing to a recent healthy worker signal. Record that evidence without caller data. A healthy worker signal is not a guarantee of future provider, call, or booking success.

Rollback uses the previous committed worker source and the same persistent outbox, followed by the same controlled drain/restart. Do not delete the outbox or alter call routes. The dashboard signal will age according to the existing HQ receiver/display semantics after heartbeats stop.

## Exact release files

- `src/worker-heartbeat.ts`
- `src/worker-heartbeat.test.ts`
- `src/main.ts`
- `src/staging-health-target.ts`
- `src/staging-health-target.test.ts`
- `src/staging-health-target.integration.test.ts`
- `src/livekit-gemma-eval.test.ts`
- `scripts/livekit-gemma-eval.mjs`
- `vitest.config.ts`
- `WORKER-HEARTBEAT-RELEASE.md`

Unrelated existing `scripts/__pycache__/` files are excluded from this release.

## Monitoring an already-running Windows worker

`src/worker-heartbeat-observer.ts` can observe a worker without starting or registering one. Its arguments require the verified worker PID and Windows process creation time in Unix milliseconds. Before and after each native HTTP health probe, it checks both OS listener ownership and that exact process birth time. PID reuse, a different listener, worker exit, failed probes, or missing OS evidence suppress healthy events.

Example command shape (replace both identity placeholders with freshly inspected values):

```text
node src/worker-heartbeat-observer.ts --pid VERIFIED_PID --started-at-ms VERIFIED_PROCESS_CREATION_MS
```

The observer uses the same `HQ_TELEMETRY_*` configuration, fresh HMAC signatures, receipt validation, minimal payload, and 30-second loop as the in-process reporter. It does not import the LiveKit SDK, register a worker, join rooms, or access Calendar. Do not run it alongside an updated worker's own heartbeat loop; stop the observer during the eventual controlled worker restart. A restarted worker requires a freshly verified observer identity if the observer is still needed.

Additional files: `src/worker-heartbeat-observer.ts` and `src/worker-heartbeat-observer.test.ts`. The existing-process ownership test also verifies that an explicitly identified child listener can be recognized while default self-ownership rejects that child.
