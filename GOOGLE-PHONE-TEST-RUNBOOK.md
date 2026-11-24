# VVS Smilez — existing-number Google Calendar telephone test

Prepared 2026-11-23. **NOT ROUTED OR ACTIVATED.**

## Objective

Use the existing LiveKit US number +1 (240) 212-8082 for ONE explicitly authorized
fictional cleaning reservation through a real inbound SIP call.

- Original project: `spanish-receptionist-testing` (`p_10zuy741dsq`)
- Existing worker: `my-agent` (health port 8081), stays running
- Existing dispatch rule: `SDR_ty9Bjf2zg3jZ` still targets `my-agent`
- Temporary phone worker: `vvs-google-phone-test` (health port 18083), registered
  to the same ORIGINAL LiveKit project but has no inbound dispatch yet
- Separate staging project and browser test are unchanged
- Synthetic Google test: November 24, 2026, at 14:00–15:15 (America/Tijuana)
- Private fresh one-use phone audit state outside source control
- No patient names, phones, or appointment invitations in the Google event
- The single synthetic Google event **must remain in Calendar after hangup**. No automatic event cleanup.
- The one-use audit ledger must remain stored after the call; never reset it to retry booking.
- Manual cleanup is available ONLY if the operator later explicitly requests deletion.

This is a **temporary reroute of an existing number**. Other incoming calls during the
test window will reach the synthetic-test worker instead of the normal receptionist.
The operator must get explicit approval to switch the live route for the test window.

## Readiness and safety

- The original and phone test workers must both be healthy on 8081 and 18083.
- Original SIP route must exactly match the private snapshot:
  `%LOCALAPPDATA%\VVS-Smilez-Phone-Pilot\original-dispatch-rule.json`
- Verify that only the expected original dispatch rule exists and targets `my-agent`.
- Phone bridge stays disarmed in `.env.google-phone-test.local` until actual routing
  is switched and independently confirmed.
- Do not set real patient booking permissions or switch the original agent mode.
- Avoid repeating this one-time test by clearing the private audit ledger. Never reset it.
- Charges: the LiveKit call uses metered minutes and AI inference, and the caller's
  mobile provider may bill for international or long-distance calling.

## Preflight (read-only)

From the source root in Windows PowerShell:

```powershell
python .\scripts\phone-pilot-route.py status
node src/google-pilot/phone-reconcile.ts status
```

Preflight must say original route `my-agent`, unarmed, both ports listening,
original backup matches, and phone pilot audit `unused`.

## Temporarily switch the number (ONLY after explicit user authorization)

```powershell
python .\scripts\phone-pilot-route.py activate --authorized-now
```

This must verify live routing, preserve the original rule's other fields, and
atomically arm the local test gate. A **Windows Task Scheduler fallback** is
created before switching, to restore the original route in 12 minutes if the
operator loses contact. If scheduling fails, activation stops without switching.
This fallback is an additional safeguard, not a guarantee against a powered-off
computer or disabled Task Scheduler. If activation or readback fails,
**do not call**; restore original routing. Keep the test window short and
restore manually immediately after hangup rather than relying on the timer.

## Test call

Place one real phone call to the EXISTING number. Say in Spanish:

"Hola. Quiero hacer una prueba técnica de calendario para una limpieza el
24 de noviembre a las dos de la tarde. No es una cita para un paciente."

When asked, say:

"Sí, confirmo que quiero crear únicamente un evento temporal de prueba
en Google Calendar. Prueba técnica de calendario."

Keep call active while verifying the test event on the VVS Smilez Google Calendar:
`VVS Smilez — CITA TÉCNICA DE PRUEBA (conservar)` from 2 PM to 3:15 PM.

Hang up. **The event must remain confirmed and visible after hangup.**

## Restore original phone routing (mandatory)

```powershell
python .\scripts\phone-pilot-route.py restore
python .\scripts\phone-pilot-route.py status
```

Status must show `CURRENT_ROUTE_AGENT=my-agent`,
`PHONE_BRIDGE_ARMED=False`, and `ORIGINAL_BACKUP_MATCHES=True`.
Do not leave the existing number directed to the temporary worker.

## Independently verify retained Google event

```powershell
node src/google-pilot/phone-reconcile.ts status
```

Expect `PHONE_PILOT_STATE=created`,
`GOOGLE_WRITE_VERIFIED=true`, `GOOGLE_CLEANUP_VERIFIED=false`, and
`EXACT_TEST_EVENT_STATUS=confirmed`. The test event must remain visible in Calendar.
Only if the operator **later explicitly requests deletion**, run the id-specific cleanup command:

```powershell
node src/google-pilot/phone-reconcile.ts cleanup
node src/google-pilot/phone-reconcile.ts status
```

The cleanup routine deletes only the synthetic event ID in the one-use ledger;
it does not clear the calendar or touch unrelated real appointments.

## Failure recovery

1. If anything unexpected happens, `restore` the original phone route first.
2. Verify `my-agent` is still running and number routes to it.
3. Examine the phone audit ledger using `phone-reconcile.ts status` and verify
   the test event is still confirmed. Never run cleanup without a separate deletion request.
4. If the backup differs from live routing, do not overwrite unknown third-party
   changes; investigate manually.
5. Do not purchase a new number, activate normal patient bookings, or push code
   to the public GitHub origin during this test.

**Pass criteria**: a SIP caller reaches `vvs-google-phone-test` on the existing
number, the consented synthetic Google event is created and read back, the event
remains confirmed after hangup, the one-use audit ledger records creation, and the
original phone dispatch rule is restored and verified.

Browser voice success alone does not satisfy this telephone test.
