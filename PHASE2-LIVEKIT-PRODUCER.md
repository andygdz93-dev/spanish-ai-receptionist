# VVS Smilez — LiveKit operational event producer / durable retry

Implementation: 2026-11-23. **Opt-in only. Not running in the existing worker process. No calls or deployments performed.**

## What changed

The LiveKit entrypoint `src/main.ts` calls `attachOperationalLifecycle(ctx)` after the room connection succeeds. This is **disabled unless `HQ_TELEMETRY_PRODUCER_ENABLED=yes`**. The existing Node process was not restarted and no new paid voice session was created.

- `src/operational-lifecycle.ts`: registers a LiveKit `JobContext.addShutdownCallback`; records a room-session start when connected, a completion at normal shutdown, or one terminal failure if the agent emits a **non-recoverable** `AgentSessionEventTypes.Error` event or a synchronous greeting fails. Recoverable errors do not mark the session failed. If local telemetry fails, voice operation continues.
- `src/operational-producer.ts`: constructs privacy-safe events and fresh request HMAC signatures, sends with timeouts, categorizes responses, and retries nonfatal errors.
- `src/operational-outbox.ts`: durable on-disk SQLite WAL queue, atomic leases, ordered per-session delivery, duplicate prevention, bounded retry delays, persistent dead letters and summary counts.
- `src/telemetry-drain.ts`: **separate opt-in retrier** that can continue draining the outbox after job processes exit. It is not auto-started or scheduled.
- `.gitignore` and `.dockerignore`: ignore the default local SQLite outbox and WAL/state files. Never check outbox files into Git, backups, Docker images or shared folders.
- HQ: `src/operational-events.ts` now accepts a signed historical event up to 7 days old. The **request signature timestamp** is still limited to ±120 seconds, preventing replay of stale signed envelopes.

A `call_started` event here means the agent **joined a LiveKit room**. It does not prove an inbound SIP call, a connected phone line, successful audio, or a real appointment. The source is emitted as `livekit` only when this opt-in hook is enabled. Room names, participant metadata, SIP identifiers, phone numbers, transcripts and model error details are not sent. The `sessionId` is an opaque SHA-256 derivative of `ctx.job.id`, and `eventId` is a UUID.

## Protocol and semantics

The producer sends `POST /api/internal/telemetry` to HQ, using a fresh timestamp (13-digit milliseconds), a fresh random nonce and `HMAC-SHA256(secret, 'v1\\n' + timestamp + '\\n' + nonce + '\\n' + exactPayloadBytes)`. Event IDs and original event timestamps remain stable on retry. Accepted `202` and acknowledged duplicate `200` mark the outbox row delivered. Network failures, HTTP 408/429/5xx are retried with exponential backoff capped at 5 minutes. Other HTTP 4xx are persisted as **dead letters**, never discarded.

The outbox uses `BEGIN IMMEDIATE` to lease each row atomically across multiple Node worker processes and a standalone retrier. Leases expire after 15 seconds, and stale acknowledgments are rejected. Events from one session remain ordered: a completion/failure is blocked until its start has been delivered. Failures leave diagnostic counts locally, not patient text. A failed start that becomes a dead letter will intentionally block the later terminal event, requiring operator review.

**Important operational limits:** If a worker process is forcibly terminated before its shutdown callback runs, it may never queue a terminal event. The database remains durable only if the `.sqlite`, `-wal`, and `-shm` files reside on persistent writable storage. Without the independent retrier running, queued events wait until another job attempts a flush. Events older than 7 days will be rejected by HQ and preserved as dead letters. There is no automated alerting or stale-session reconciliation yet.

## Secure opt-in requirements — DO NOT enable without a controlled review

The operator must separately provision server-only values for **both** HQ receiver and the LiveKit worker:

- `HQ_TELEMETRY_BUSINESS_ID` — **same active clinic UUID** in both processes.
- `HQ_TELEMETRY_WORKER_ID` — **same dedicated, preauthorized instance ID** in both.
- `HQ_TELEMETRY_SIGNING_SECRET` — same strong random secret (>=32 bytes), kept outside Git and browser data.
- `HQ_TELEMETRY_ENDPOINT` — HTTPS HQ private ingest URL or loopback `http://127.0.0.1:8787/api/internal/telemetry`.
- `HQ_TELEMETRY_OUTBOX_PATH` — persistent, private path ending in `.sqlite`; choose a location **outside all repositories** for custom names.
- `HQ_TELEMETRY_PRODUCER_ENABLED=yes` — enables the worker emitter **and** the standalone drainer.
- `HQ_TELEMETRY_ALLOW_LIVEKIT=yes` — enables HQ to accept **actual LiveKit sourced** events, but only after credentials and session identity have been validated.

Do not put these values in a prompt, room metadata, client-side code, email, chat or repository. The current HQ design supports one pinned business/worker pair per receiver, not a multi-tenant hosted credential broker. The target machine needs Node 24+ with `node:sqlite` available.

**Only after explicit authorization and secure configuration**, the standalone drainer can be launched from the voice project using `node src/telemetry-drain.ts` and stopped with Ctrl+C; `node src/telemetry-drain.ts --once` performs a single best-effort drain. The drainer must run under a supervised service with persistent storage for ongoing durability; none was started in this implementation.

## Offline verification

1. Voice: `node_modules\\.bin\\vitest.cmd run --fileParallelism=false`; `node_modules\\.bin\\tsc.cmd --noEmit`; focused ESLint.
2. HQ: `node_modules\\.bin\\vitest.cmd run`; `node_modules\\.bin\\tsc.cmd --noEmit`.
3. Contract test (on the same Windows machine with both sibling project folders): from HQ, run `node --import tsx tests/voice-producer-contract.mjs`. This creates a **disposable** HQ PGlite database, keeps HQ temporarily offline, records a mocked `JobContext` start/completion into the SQLite outbox, starts disposable HQ, retries, and checks authenticated history. **No paid inference or SIP calls**.
4. Native worker read-only check: `GET http://127.0.0.1:8081/`. A successful 200 verifies the currently running worker health endpoint at that instant, not the ability to handle a real call. LiveKit documentation: https://docs.livekit.io/agents/server/options/ and https://docs.livekit.io/agents/server/job/

**Remaining:** hosted identity/secret rotation, verified LiveKit worker deployment/rollout, long-running supervised drainer, monitoring dead letters/queue depth, stale-session reconciliation, capacity/load testing, real call trace correlation and production readiness/security review. The private GitHub source-of-truth mismatch from Phase 0 remains unresolved. No Git pushes or live worker restart occurred.
