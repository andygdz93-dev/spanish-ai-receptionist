# VVS Smilez — isolated one-call Google Calendar pilot
Date: 2026-11-23. Status: source built and locally tested, NOT activated.

## Goal and accepted evidence
The pilot is a dedicated inbound LiveKit phone call to a separate worker named vvs-google-pilot in a separate LiveKit project. The caller requests a fictitious cleaning at ONE configured date/time. The worker reads Google Calendar free/busy, obtains explicit confirmation, inserts ONE test-only event, reads it back, and reports success. On call shutdown, it attempts to cancel the event and verifies its status and free/busy. The operator must run independent reconciliation after the call.

The existing my-agent, the +1 (240) 212-8082 number, and port 8081 must remain unchanged. No normal patient booking permissions are enabled.

## Implemented source
- src/google-pilot/pilot.ts — separate config gate, locked one-use audit ledger, Google adapter, verified creation and cleanup
- src/google-pilot/main.ts — standalone LiveKit entrypoint with a separate agent name and port; exclusively fictional booking tools
- src/google-pilot/reconcile.ts — status and cleanup utility for independent verification or crash recovery
- src/google-pilot/pilot.test.ts — provider-mocked controls, no cloud calls
- .env.google-pilot.example — safe template only; actual .env.google-pilot.local is ignored by Git

## Controls
- Production bookings remain off; pilot requires DENTAL_DEMO_MODE=no and DENTAL_BOOKINGS_ENABLED=no, plus three independently approved pilot flags.
- A different LiveKit Cloud URL and API key than the existing production/demo worker are mandatory.
- The pilot only targets the dedicated VVS Smilez Google calendar.
- One predeclared weekday cleaning, 09:00–17:00 Tijuana local, within 14 days and at least one hour ahead.
- Service is fixed: one fictional cleaning, 60 minutes plus 15-minute buffer.
- No patient names, telephone numbers, emails, caller-provided text or attendees are added to the Google event.
- Google insert uses sendUpdates=none (no event invitations).
- Reservation is fail-closed with an exclusive local file lock stored OUTSIDE the source repository. A failed/uncertain insert is never silently retried.
- Reconciliation deletes only the exact generated event ID. A Google cancelled record is expected to remain queryable sometimes and is not an active appointment.
- The one-use ledger must be kept after cleanup; do not reset it to run another call.
- No SMS, appointment reminders, HQ telemetry activation, or new Windows service setup is included.
- The worker can incur LiveKit STT, TTS, and inference cost. Agree on an explicit spending cap before activation.
- Audio SDK logs may contain spoken words; pilot callers must use fictional information only.

## What remains blocked
1. Separately reviewed isolated LiveKit Cloud project, URL, keys, and agent registration.
2. Dedicated test phone number/dispatch routing to vvs-google-pilot on that project. Purchasing or rerouting a number needs explicit authorization.
3. Approved protected OAuth credentials with access ONLY to the dedicated VVS Smilez test calendar.
4. Exact chosen future weekday/date/time; ensure no conflict and create a protected private state directory outside Git.
5. Explicit authorization to activate the stage worker and carry out a paid controlled phone call, including a spending limit.
6. Private GitHub source-of-truth remains unresolved; do not push this branch to the public origin.

## Operator runbook (ONLY after approval and verification)
1. Copy .env.google-pilot.example to .env.google-pilot.local without modifying .env.local or .env.staging.local.
2. Populate independent LiveKit credentials, Google OAuth credentials, date/time, and state file path in protected local config. Do not paste secrets into chat or Git.
3. Confirm the dedicated staging number dispatches only to vvs-google-pilot. Confirm port 18082 (or configured port) is unused.
4. Set VVS_GOOGLE_PILOT_APPROVED, VVS_PILOT_PROJECT_REVIEWED, VVS_PILOT_CALL_ROUTE_VERIFIED to yes ONLY after actual review.
5. Windows PowerShell, from project root: node src/google-pilot/main.ts start --log-level info
6. Call the dedicated test number and say, in Spanish: "Quiero crear la única cita técnica de prueba para una limpieza dental. Sí, confirmo que es un evento temporal de prueba."
7. Hang up. Inspect GOOGLE_PILOT_CLEANUP outcome from the worker log.
8. Verify independently: node src/google-pilot/reconcile.ts status
9. If needed, run: node src/google-pilot/reconcile.ts cleanup
10. Verify the ledger is cleaned and Google test event cancelled/not found. If marked attempted/needs_review, investigate; never retry booking by resetting ledger.
11. Stop ONLY the isolated pilot worker. Keep audit ledger privately and leave the existing my-agent running.

## Pass/fail
PASS means actual inbound SIP call reached the isolated project/agent, explicit fictional consent was captured, Google creation and read-back succeeded, the correct event was deleted or cancelled, and the audit ledger is cleaned. Google API-only tests, desktop LiveKit console calls, source tests, or an HTTP 200 health response do NOT prove this complete chain.

## Failure/rollback
If shutdown cleanup fails, reconcile using the known event ID before any other call. Never delete unrelated calendar events. A busy slot after cleanup may be caused by another real booking; verify the test event's own ID/status rather than blindly clearing calendar items. Do not enable general patient bookings or change the existing phone route.

Reference docs:
https://docs.livekit.io/telephony/accepting-calls/dispatch-rule/
https://docs.livekit.io/telephony/testing/
https://developers.google.com/workspace/calendar/api/guides/create-events
