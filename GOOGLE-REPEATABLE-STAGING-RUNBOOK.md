# VVS Smilez — Repeatable Browser-Only Google Calendar Staging

## Purpose

Verify realistic Spanish appointment conversations in LiveKit's **isolated VVS Smilez Pilot** project.
This is not the normal telephone receptionist. The new agent is `vvs-calendar-staging`,
health port `18084`; it must never be attached to any SIP dispatch rule.

- Dedicated synthetic-only Google Calendar, never a patient's personal calendar.
- Appointments are **test events**, with no names, email, phone, diagnosis, or SMS.
- Weekdays 9:00–15:00, on the hour, in America/Tijuana; 75-minute duration.
- Dates must be 60+ minutes ahead, within 14 days.
- One confirmed booking per browser session; multiple sessions can book **different** slots.
- No booking without explicit consent; no automatic deletion at hangup.
- Google API insert + exact event readback required before reporting success.
- Private one-use ledger per slot, in `%LOCALAPPDATA%\VVS-Smilez-Staging-Calendar`.
- At most 20 committed/attempted stage slots per local environment.
- A failed/ambiguous write consumes its slot until operator reconciliation. NEVER erase an audit file to retry.
- An already-booked or busy slot is rejected. Request another time.
- Old `vvs-google-pilot` and existing telephone `my-agent` stay unchanged.

## Files

- `src/google-pilot/staging-main.ts`: isolated staging worker and Spanish voice tools.
- `src/google-pilot/staging-scheduler.ts`: slot validation, persistent event creation, durable audit.
- `src/google-pilot/staging-scheduler.test.ts`: provider-mocked tests.
- `.env.google-staging.local`: ignored private controls; no credentials.
- `.env.google-pilot.local`: existing OAuth and isolated LiveKit credentials.

## Before running

1. Confirm original SIP rule still points to `my-agent`.
2. Run `pnpm exec vitest run src/google-pilot/staging-scheduler.test.ts`,
   `pnpm typecheck`, and `pnpm exec eslint src/google-pilot/staging-main.ts src/google-pilot/staging-scheduler.ts`.
3. Prefer `VVS_STAGING_ALLOW_WRITES=no` for initial setup. The automated
   `staging-voice-smoke.ts` sends no date, booking request, or confirmation,
   and can run with either explicit write flag; it performs no Calendar write.
4. Launch from the repository root:
   `node src/google-pilot/staging-main.ts start --log-level info`
5. Verify the worker registers in the isolated project and port 18084 listens.
6. Launch **VVS Smilez Pilot → Agents → vvs-calendar-staging → Console**.
   Never run the `vvs-google-pilot` console for repeatable booking.
7. When ready for synthetic Calendar writes, explicitly set
   `VVS_STAGING_ALLOW_WRITES=yes` in the private env and **restart ONLY staging worker**.
   This flag cannot enable patient bookings or telephony.

## Browser conversation script

Say in Spanish: "Hola, quiero hacer una prueba técnica. ¿Está disponible una limpieza
el 25 de noviembre de 2026 a las diez de la mañana, hora de Tijuana?"

After availability check: "Sí, confirmo que quiero guardar solo un evento de prueba
en Google Calendar, que permanezca después de terminar esta sesión."

For another session, pick a different valid weekday/time.

## What must be checked

- Console shows **2 participants** and agent-generated TTS.
- No partial transcript is treated as consent.
- Check tool returns `available` before booking.
- Booking tool returns `booked` and `savedInGoogleCalendar:true`.
- Open the dedicated Calendar; check exact title
  `VVS Smilez — CITA TÉCNICA DE PRUEBA (conservar)` and date/time.
- Close browser session. Event remains confirmed; ledger status `created`.
- A repeated booking of the same slot is rejected; different available slots can succeed.
- No live telephone calls are used for staging validation.

## Latency/error diagnostics

LiveKit Agent Console exposes Events and Metrics. This worker emits the following
safe timing markers, with milliseconds measured from worker job entry:
`VVS_STAGING_ROOM_CONNECTED_MS`, `VVS_STAGING_PARTICIPANT_CONNECTED_MS`,
`VVS_STAGING_VOICE_STARTUP_MS`, `VVS_STAGING_GREETING_QUEUED_MS`.
An additional `VVS_STAGING_MODEL_ERROR` marker records recoverability, but not patient text.

The previous browser test had an `inference.LLM` error and approximately 3.4-second
end-to-end latency. A Console warning "Version not fully supported" alone does not
establish an SDK upgrade need; inspect SDK version and the expanded error first.
Model errors still require exact error code/message inspection before changing provider.

## Emergency controls

- Disable further staging writes: set `VVS_STAGING_ALLOW_WRITES=no`;
  restart ONLY staging worker.
- Never alter the SIP rule while investigating browser staging.
- Never delete any stage event or audit ledger automatically.
- If a Google write is uncertain, inspect the one-use slot ledger and matching
  event by ID before deciding whether manual intervention is appropriate.

## Verified engineering results — November 23, 2026

- Static validation: 17/17 targeted tests, TypeScript, and ESLint passed.
- LiveKit explicit dispatch / browser participant: agent joined and generated Spanish output.
- Google Calendar: synthetic event for November 26 at 11:00 and November 27 at 10:00
  (America/Tijuana) created; each durable ledger says `created` with `writeVerifiedAt`.
- The November 27 event was independently read back from Google Calendar **after the
  LiveKit session disconnected**; the exact event ID matched and status was `confirmed`.
- The real-time job no longer directly loads Google SDK or performs Google OAuth:
  `staging-calendar-rpc.ts` sends only date/time/confirmed to
  `staging-calendar-worker.ts` in a dedicated Node worker thread.
- Read-only RPC check: November 27 at 10:00 was available before booking;
  a historical year (2024) was rejected as `invalid_slot`.
- Staging LLM uses `openai/gpt-4.1-mini`; this change addresses a demonstrated
  incorrect-year tool call from the former model. Exact root cause of an older
  `inference.LLM` error was not separately established.
- LiveKit worker now sets `numIdleProcesses:1` and
  `initializeProcessTimeout:30000`. This reduces local Windows prewarm CPU
  contention; the post-change browser smoke test had **no observed**
  `runner initialization timed out` error.
- The post-change smoke test queued the greeting at approximately 570 ms after
  job entry. This is **not** a measured time-to-first-audible-word.
  Transcription rotation and some event-loop warnings still occurred.
- Normal LiveKit number route remains `my-agent` with the original worker
  listening on port 8081. Isolated staging listens on port 18084. The older
  phone-test worker is not required for browser staging.
- Two real-world limitations remain: an actual human browser audio-quality test
  has not been independently verified, and local Windows terminal workers can
  become unavailable when the computer or sessions stop. A supervised always-on
  deployment is required before relying on paid inbound patient calls.

**Never clear private per-slot audit files to reuse the same time, and never
delete synthetic events without a separately authorized cleanup.**

## Follow-up capacity test and cleanup — same day

A later smoke test ran while another staging voice session was active. It received
LiveKit dispatch but did NOT see the AI participant join within 25 seconds.
It exited with code 1, without booking. LiveKit reported voice activity detection
falling roughly 9 seconds behind real time and repeated worker-init timeouts.
Therefore **one successful single-session smoke test is not proof of concurrency
reliability**. The one-idle-process/30-second-timeout settings did not eliminate
the under-load failure.

The Windows host was an Intel i5-6500 with 4 logical processors, about 16 GiB
RAM (4.79 GiB free), and 87% CPU load at the time of inspection. LiveKit logged
host process scheduling delays. Treat Windows CPU contention as a remaining
operational blocker. Do not route paid patient calls to this staging worker.

Five stale automated-test Node.js processes were found after their test rooms
had disconnected and were explicitly terminated by verified PID. The smoke and
full E2E scripts now explicitly exit after completing teardown and readback so
they do not leave native RTC handles running in the background.

**Before accepting real phone traffic**, run a no-load and a two-caller soak
test on a dedicated supervised host with verified capacity, alert on warm
process failures, and enforce bounded wait/fail-fast on dispatch. No real
patient data should enter the staging Calendar.

## Spanish conversation and first-audio update — November 23, 2026

The isolated `vvs-calendar-staging` agent now has its own `STAGING_GREETING`
in `src/google-pilot/staging-dialogue.ts`:

"Hola, buenos días. Le habla la asistente virtual de la dentista Florencia.
¿En qué puedo ayudarle?"

The shared normal receptionist greeting in `src/greeting.ts` is not changed.
The staging prompt now targets one or two short sentences and one question per
reply, avoids repeated hour questions, and instructs the model to retain dates
and times supplied in separate turns.

`normalizeStagingSlot` deterministically accepts cases such as
"el 25" (only when unambiguously upcoming in the current month),
"25 de noviembre", "11 de la mañana", "a las once", and "2 de la tarde".
It rejects invalid or ambiguous expressions without silently inventing dates.
Date/time changes are verified against the approved Calendar scheduler limits.
Bookings also require a matching availability check plus explicit confirmation.

Verification:
- 37 targeted unit tests passed; TypeScript and ESLint passed.
- A no-phone LiveKit probe subscribed to the audio track and received the first
  non-silent decoded PCM frame **2,017 milliseconds** after dispatch started.
  Agent joined at 342 ms; audio track subscribed at 1,227 ms; first audio frame
  arrived at 1,237 ms. This is client-side RTC decoded audio, **not** confirmed
  playback through physical speakers or a SIP telephone.
- LiveKit synthetic conversation with "lunes 30 de noviembre de 2026 a las
  once de la mañana" correctly recognized 11:00 without asking for the hour
  again, checked availability, explicitly asked for confirmation, and booked.
- After disconnect, Google Calendar confirmed the synthetic appointment for
  November 30, 2026 at 11:00 AM Tijuana time, with exact event ID matched.
- Test-only node process exited normally. No real customer or phone use.
- The model still used slightly awkward Spanish ("¿Confirmo esa hora para
  reservarla?"), so human evaluation of tone and pronunciation is still needed.
- A single good startup sample is **not** a p95/p99 guarantee. Windows CPU
  contention and earlier two-session startup failures remain release blockers.

Do not redirect the production phone number for this staging test.

## Sequential synthetic response benchmark — November 23, 2026

Purpose: test baseline versus tuned dialogue latency and response lengths WITHOUT
phone calls or Calendar writes. Tests used the isolated `vvs-calendar-staging`
worker on port 18084; synthetic questions were delivered through LiveKit text
messages, measuring time from send to the first **non-silent decoded AI audio
frame** at an RTC client. This is NOT user speech end-to-end latency or physical
speaker playback, and it cannot validate STT or spoken turn detection.

**Baseline** (4 separate RTC rooms, 3 identical test questions per room,
12/12 successful): nearest-rank p50=1,690ms, p95=3,449ms.
Individual samples: 1493,1488,1465,1959,3449,2197,1696,1366,1976,
1419,1690,1809ms. Average response length 21.25 words (15–25),
0 turns over 30 words, 0 missing responses.

**Tuned staging settings**:
- `turnHandling.endpointing={mode:'dynamic',minDelay:850,maxDelay:2200,alpha:0.8}`
- `turnHandling.preemptiveGeneration={enabled:false}`
- Spanish dialogue target 15–22 words; max 24 except required notice/confirmation
- `inference.TurnDetector()` kept unchanged; original phone `my-agent` untouched.

**Tuned** (same 4 rooms x 3 questions, 12/12 successful): nearest-rank
p50=1,401ms, p95=1,617ms. Samples:
1471,1263,1147,1561,1486,1519,1460,1401,1208,1617,1257,1271ms.
Average response length 19.83 words (13–24), 0 over 30 words,
0 missing responses. Observed p50 improved by 289ms (17.1%),
p95 by 1,832ms (53.1%).
These differences are observations on small samples, NOT causal production
guarantees. Host CPU load was not experimentally held constant.

**Spoken-input limitation**: Three attempts to deliver es-MX synthetic WAV
speech (Microsoft Sabina Desktop PCM16 16kHz) with deliberate 850ms pauses
did NOT produce a valid STT transcript/response pair. The initial attempt
mistakenly counted the greeting tail; subsequent corrected probes produced
no valid speech response, even after publishing the microphone track after
the agent joined. No legitimate spoken-turn p50/p95 or conclusion about
the tuned pause boundary can be drawn. LiveKit job logs reported VAD inference
1.7–1.9 seconds slower than real time and event-loop scheduling stalls under
Windows host CPU contention. Next gate: human Chrome microphone trial or
a validated published-audio test on a dedicated supervised worker host,
followed by two-caller load testing.

Benchmark artifacts (locally in Windows TEMP):
`vvs-smilez-text-benchmark-baseline-n12.json` and
`vvs-smilez-text-benchmark-tuned-n12.json`.
Scripts: `src/google-pilot/staging-text-latency-benchmark.ts` and
`src/google-pilot/staging-paused-audio-benchmark.ts`.

37/37 targeted tests passed; TypeScript and ESLint checks passed. Calendar
write control was temporarily `no` for the benchmarks and **restored to
`yes`** afterward for synthetic browser-only bookings. Staging worker was
restarted in isolation and registered successfully on LiveKit Cloud.
No synthetic events were created or deleted by these benchmarks.
