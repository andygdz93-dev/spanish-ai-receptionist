# Worker heartbeat release

## Behavior

- The production start entrypoint starts one heartbeat loop in the worker parent process. Staging retains its separate health reporter.
- Reuses the existing `HQ_TELEMETRY_*` producer configuration, identity, HMAC signing helper, receiver endpoint, and durable outbox configuration. No additional environment setting is required.
- Probes immediately and approximately every 30 seconds, with at most one operation in flight. A healthy event requires OS ownership of the native loopback health listener and an HTTP 200 from that listener. Ownership is checked again after the probe.
- Uses the existing `worker_heartbeat` receiver contract and aggregate queue diagnostics. Signs the exact bytes with a fresh timestamp and nonce. Delivery requires HTTP 200/202 plus an exact matching event ID and accepted/duplicate receipt.
- Heartbeats are current observations and are not queued for historical replay. Call lifecycle events retain their existing durable queue, retries, ordering, and dead-letter behavior.
- Payloads exclude transcripts, phone numbers, room names, patient details, and booking contents. Stop signals cancel scheduling and abort in-flight heartbeat requests.
- Windows ownership uses numeric OS listener/PID data. Linux checks the current process's socket descriptors. Missing or ambiguous evidence suppresses healthy events; unsupported platforms fail closed.

## Existing-process observer

The optional Windows observer can monitor an already-running worker without starting or registering another one. It requires a freshly verified process PID and creation timestamp. Before and after each health probe it checks listener ownership and that exact process birth time. PID reuse, worker exit, failed probes, or missing evidence suppress healthy events.

```text
node src/worker-heartbeat-observer.ts --pid VERIFIED_PID --started-at-ms VERIFIED_PROCESS_CREATION_MS
```

It does not import the LiveKit SDK, register a worker, join rooms, or access Calendar. Do not run it alongside an updated worker's own heartbeat loop. It is a process, not a service supervisor: host or worker restart requires a newly verified identity. Production activation and recovery instructions belong in the private operations runbook.

## Validation

- Full local worker suite: **28 files, 166/166 tests passed**.
- TypeScript, changed-source ESLint, and changed-file formatting passed.
- Scheduler coverage includes 30-second cadence, no overlapping sends, stop/abort, and shutdown-listener cleanup.
- Additional coverage verifies signed minimal payloads, exact receipts, unavailable/unhealthy probes, missing or changing listener ownership, process birth time, and disposable child-listener attribution.
- Gemma preflight imports the native SDK only after credential, budget, and source checks; tests clear both budget-approval variables. Windows listener detection uses asynchronous OS commands. Windows test files run serially to reduce dependency-loading contention without extending test deadlines.
- Routing and booking implementation are unchanged. Unit and integration tests do not establish real-call or booking success.

## Files

- `src/worker-heartbeat.ts`
- `src/worker-heartbeat.test.ts`
- `src/worker-heartbeat-observer.ts`
- `src/worker-heartbeat-observer.test.ts`
- `src/main.ts`
- `src/staging-health-target.ts`
- `src/staging-health-target.test.ts`
- `src/staging-health-target.integration.test.ts`
- `src/livekit-gemma-eval.test.ts`
- `scripts/livekit-gemma-eval.mjs`
- `scripts/check-changed-format.mjs`
- `vitest.config.ts`
- `WORKER-HEARTBEAT-RELEASE.md`

The separately prepared workflow change is not part of the published application release. Remote CI success is not claimed.
