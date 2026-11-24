// Read-only staging checks. Never writes events or changes LiveKit routing.
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { StagingScheduler } from './staging-scheduler.ts';

const [action,date,time] = process.argv.slice(2);
if (action !== 'availability' || !date || !time)
  throw new Error('Usage: node src/google-pilot/staging-readiness.ts availability YYYY-MM-DD HH:mm');
const stagingEnv = parse(readFileSync('.env.google-staging.local','utf8'));
const scheduler = new StagingScheduler({
  isolatedEnv: parse(readFileSync('.env.google-pilot.local','utf8')),
  originalEnv: parse(readFileSync('.env.local','utf8')),
  stagingEnv, root: process.cwd(),
});
const status = await scheduler.availability(date,time);
console.log('STAGING_BROWSER_ONLY=',stagingEnv.VVS_STAGING_BROWSER_ONLY === 'yes');
console.log('STAGING_WRITE_PERMISSION=',stagingEnv.VVS_STAGING_ALLOW_WRITES === 'yes');
console.log('STAGING_DATE=',date);
console.log('STAGING_TIME=',time);
console.log('GOOGLE_CALENDAR_SLOT_STATUS=',status);
