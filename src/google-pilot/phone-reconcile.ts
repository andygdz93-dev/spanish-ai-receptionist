// Inspect or clean ONLY the synthetic event made by the existing-number phone pilot.
// This script is independent of the SIP routing state and works after a crash.
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { DateTime } from 'luxon';
import { GooglePilot, googlePilotCalendar, readPilotConfig, readPilotState } from './pilot.ts';

const action = process.argv[2];
if (action !== 'status' && action !== 'cleanup') {
  console.log('Usage: node src/google-pilot/phone-reconcile.ts status|cleanup');
  process.exit(2);
}

const phone = parse(readFileSync('.env.google-phone-test.local', 'utf8'));
const isolated = parse(readFileSync('.env.google-pilot.local', 'utf8'));
const original = parse(readFileSync('.env.local', 'utf8'));
const config = readPilotConfig({
  ...isolated,
  VVS_PILOT_TEST_DATE: phone.VVS_PHONE_TEST_DATE,
  VVS_PILOT_TEST_TIME: phone.VVS_PHONE_TEST_TIME,
  VVS_PILOT_STATE_PATH: phone.VVS_PHONE_TEST_STATE_PATH,
}, original, process.cwd(), DateTime.now(), true);
const audit = readPilotState(config.statePath);
const pilot = new GooglePilot(config, googlePilotCalendar(config));
if (action === 'status') {
  console.log('PHONE_PILOT_STATE=', audit?.status ?? 'unused');
  console.log('GOOGLE_WRITE_VERIFIED=', Boolean(audit?.writeVerifiedAt));
  console.log('GOOGLE_CLEANUP_VERIFIED=', Boolean(audit?.cleanupVerifiedAt));
  if (audit) {
    const actual = await pilot.cal.get(audit.eventId, config.calendarId);
    console.log('EXACT_TEST_EVENT_STATUS=', actual?.status ?? (actual ? 'confirmed' : 'not_found'));
    console.log('EXACT_TEST_EVENT_ID_MATCH=', actual?.id === audit.eventId);
  }
} else {
  const result = await pilot.cleanup();
  console.log('PHONE_PILOT_CLEANUP=', result.status);
  console.log('TEST_SLOT_BUSY=', result.slotBusy === null ? 'unknown' : result.slotBusy);
  if (result.status === 'needs_review') process.exitCode = 1;
}
