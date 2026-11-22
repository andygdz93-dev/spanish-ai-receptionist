# Dental receptionist: safe demo and Google Calendar pilot setup

## Current sandbox (safe testing)

The running development agent can use `DENTAL_DEMO_MODE=yes` in `.env.local`.
This is a **fictional, in-memory calendar**, not a connected Google Calendar.
It has no Google credentials, notifications, real clinic, or persistent events.
The demo overrides real Google Calendar credentials even if they exist.
It uses placeholder service durations (`limpieza`: 60, `consulta`: 30, `revisión`: 30)
and fictional hours Monday–Friday 09:00–17:00 America/Tijuana.
Patients must use *fictional details only*; the demo backend substitutes
`Paciente Prueba / 0000000000` before simulated booking.
Demo appointment IDs begin `DEMO-`. Restarting the worker clears all reservations.
When calling the agent, it should explicitly say this is a demonstration.

To switch to a real authorized office later: first disable `DENTAL_DEMO_MODE`,
then follow the OAuth and business verification steps below. Never enter real
patient details while demo mode is running.


Status: implementation is local, calendar booking is **disabled by default**.
Do not use a personal calendar. The dental office must authorize its own dedicated calendar.

## 1. Get clinic-approved settings
- Dental office name and time zone (IANA: e.g. America/Tijuana; verify the real office location).
- Dental service names and appointment durations approved by the office.
- Working days and appointment hours for the calendar being managed.
- One office-controlled Google Calendar ID and a staff notification email.
- Clear patient-information handling and access policy.

## 2. Authorize Google Calendar
- Use a Google Cloud project controlled/approved by the office, enable Google Calendar API.
- Configure OAuth consent and an OAuth 2.0 client.
- Have the authorized office account grant the application **Google Calendar access**.
- Obtain a refresh token through an approved OAuth flow. Do not send tokens through chat.
- Keep CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN on the server only in .env.local or a secrets manager.
- The authenticated Google account must have edit rights to DENTAL_CALENDAR_ID.
- Use a dedicated dental office calendar; do not set calendar ID to an unrelated personal calendar.

## 3. Configuration (EXAMPLES ONLY — never copy unknown business facts into production)
Add to .env.local after verifying the actual values:

    DENTAL_BOOKINGS_ENABLED=yes
    DENTAL_CALENDAR_ID=<OFFICE_CALENDAR_ID>
    DENTAL_OFFICE_EMAIL=<VERIFIED_OFFICE_NOTIFICATION_EMAIL>
    DENTAL_TIMEZONE=America/Tijuana
    DENTAL_SERVICES_JSON={"limpieza":60,"consulta":30}
    DENTAL_HOURS_JSON={"1":[["09:00","17:00"]],"2":[["09:00","17:00"]],"3":[["09:00","17:00"]],"4":[["09:00","17:00"]],"5":[["09:00","17:00"]]}
    GOOGLE_CLIENT_ID=<OAUTH_CLIENT_ID>
    GOOGLE_CLIENT_SECRET=<OAUTH_CLIENT_SECRET>
    GOOGLE_REFRESH_TOKEN=<OFFICE_AUTHORIZED_REFRESH_TOKEN>

Weekdays 0=Sunday, 1=Monday, ... 6=Saturday. Durations are in minutes.
The example services and hours are placeholders, not facts about any office.
The service named by the caller must match one of the configured names.

## 4. Expected behavior
1. Patient requests a configured dental service and date.
2. Agent calls checkDentalAvailability; the backend reads Google Calendar busy periods and offers free, in-hours slots.
3. Patient supplies name and callback phone, hears slot summary, and explicitly confirms.
4. Agent calls bookDentalAppointment. It rechecks the slot and writes a private event.
5. Google Calendar is asked to send the office attendee an invitation (sendUpdates=all). **This does not guarantee email delivery.**
6. Only a successful event write allows the assistant to confirm the appointment.

Events include the minimum fields currently required by office workflow: patient name,
phone and requested service in a private event description. The office must approve this
storage and sharing practice; restrict calendar access. Consider privacy and applicable
health data regulations before real patient use. The agent must not collect diagnoses or clinical history.

## 5. Known production gates
- Confirm Google OAuth and email delivery with the office using synthetic patient data.
- Free/busy checks and a local in-process lock do not guarantee protection against
  simultaneous bookings from **multiple workers**. Use a distributed lock or transactional
  scheduling backend before scaling beyond a single worker.
- Verify real dental service duration, staff capacity, holidays, breaks, lead time,
  cancellation/rescheduling rules and appointment ownership.
- The AI's language model must not invent a successful booking.
- Configure a monitored error/office-contact fallback for failures.
- Do not turn on DENTAL_BOOKINGS_ENABLED until clinic access and policies are approved.

## 6. Voice
The default voice is currently the public Fish Audio 'Lau' model ID.
Set DENTAL_TTS_VOICE_ID in .env.local to use a different verified Fish Audio voice.
Listen to a short private LiveKit test; a configured voice ID is not proof of audio quality.
