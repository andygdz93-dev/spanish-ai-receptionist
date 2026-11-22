# Connect VVS Smilez Google Calendar to the Windows LiveKit receptionist

The dedicated VVS Smilez calendar is owned by `andygdz663@gmail.com` and uses
`America/Tijuana`. Its ID is:

`473e51b5329a173e885c3fe8db7cf83305bda22f5fa09a2441cdda034a823dc4@group.calendar.google.com`

The local `.env.local` already has the calendar ID and timezone. Demo mode remains
enabled, and real Google Calendar bookings are **not** enabled.

## 1. Create a Google Cloud OAuth client (653 account)

Use the Google account `andygdz653@gmail.com` to authorize the LiveKit application.
The VVS Smilez calendar is still owned by `andygdz663@gmail.com`: before OAuth,
share VVS Smilez with `andygdz653@gmail.com` using **Make changes to events**
permissions and accept the invitation from the 653 account. Leave public access off.

1. Visit https://console.cloud.google.com/ using the 653 account and select the
   Google Cloud project where you configured its consent screen. The Cloud
   project owner and the calendar owner may be different accounts.
2. Enable the **Google Calendar API** for the selected project.
3. In **Google Auth platform**, configure the consent screen (Branding, Audience,
   Data access). For a personal Gmail account, use the **External** audience.
   If the app is in Testing, add `andygdz653@gmail.com` as a test user.
4. Create a new OAuth 2.0 client with application type **Desktop app** under
   **Google Auth platform > Clients**.
5. Download its client JSON file. On the Windows computer only, rename it
   `google-oauth-client.json` and place it in the project root:
   `C:\Users\HP EliteDesk i5\Projects\spanish-ai-receptionist-deploy-ready`.

Do not paste OAuth client JSON, client secrets, authorization codes, refresh tokens,
or secret iCal addresses into chats or GitHub. The client JSON and `.env.local`
must remain local and excluded from Git.

## 2. Authorize from Windows PowerShell

Open PowerShell **on the Windows computer** (not on a phone or remote shell):

```powershell
cd "$HOME\Projects\spanish-ai-receptionist-deploy-ready"
node .\scripts\connect-vvs-calendar.mjs
```

A local browser will open Google's authorization page. Choose
`andygdz653@gmail.com`, read the requested permissions, and approve if correct.
The local callback verifies the account and VVS Smilez free/busy access before
saving OAuth parameters privately in `.env.local`.

The helper requests event-edit permissions for calendars accessible to this
account, a free/busy scope, and an email identity scope. This scope can also
allow access to other calendars in the account: only approve if acceptable.
The helper does not write an appointment or enable real booking.
Free/busy success alone does not prove write permission; a synthetic-event test
on VVS Smilez is required before enabling bookings.

## 3. Important gates before turning on real appointments

* Verify the office's real operating hours, services, durations, staffing, holidays
  and permission to process patient data. Demo hours are placeholders.
* Confirm the calendar integration can read free/busy and safely create, read back,
  and delete a **synthetic** test event in VVS Smilez.
* Confirm the authorized office's notification address and privacy policy.
* Google OAuth apps with External/Testing status may issue refresh tokens
  expiring in **seven days**, requiring reauthorization. Plan the production
  publishing/verification process before relying on unattended booking.
* Keep `DENTAL_DEMO_MODE=yes` until all these conditions pass; never enable
  `DENTAL_BOOKINGS_ENABLED=yes` as part of the initial OAuth setup.
* Never mix personal appointments with patient data; only the dedicated calendar
  should be used.

Google reference: https://developers.google.com/workspace/calendar/api/quickstart/nodejs
OAuth reference: https://developers.google.com/identity/protocols/oauth2
