// Read-only reconciliation of all synthetic staging events. Never deletes or books.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { DateTime } from 'luxon';
import { googlePilotCalendar, readPilotConfig, readPilotState } from './pilot.ts';

const isolated=parse(readFileSync('.env.google-pilot.local','utf8'));
const original=parse(readFileSync('.env.local','utf8'));
const stage=parse(readFileSync('.env.google-staging.local','utf8'));
if(stage.VVS_STAGING_APPROVED!=='yes'||stage.VVS_STAGING_BROWSER_ONLY!=='yes')
  throw Error('Staging audit requires isolated browser-only profile');
const dir=stage.VVS_STAGING_AUDIT_DIR;
if(!dir)throw Error('Missing private staging audit directory');
const filenames=readdirSync(dir).filter(f=>/^\d{4}-\d{2}-\d{2}_\d{4}\.json$/.test(f)).sort();
console.log('STAGING_SYNTHETIC_LEDGER_COUNT='+filenames.length);
for(const filename of filenames){
  const match=/^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})\.json$/.exec(filename);
  if(!match)continue;
  const [,date,hh,mm]=match,time=hh+':'+mm;
  const config=readPilotConfig({
    ...isolated,VVS_PILOT_TEST_DATE:date,VVS_PILOT_TEST_TIME:time,
    VVS_PILOT_STATE_PATH:join(dir,filename),
  },original,process.cwd(),DateTime.now(),true);
  const state=readPilotState(config.statePath);
  if(!state){console.log('SLOT='+date+' '+time+' AUDIT=missing');process.exitCode=1;continue;}
  const actual=await googlePilotCalendar(config,{retainAfterCall:true}).get(state.eventId,config.calendarId);
  const confirmed=state.status==='created'&&Boolean(state.writeVerifiedAt)&&
    actual?.status==='confirmed'&&actual.id===state.eventId&&
    Date.parse(actual.start??'')===Date.parse(state.start)&&
    Date.parse(actual.end??'')===Date.parse(state.end);
  console.log('SLOT='+date+' '+time+' LEDGER='+state.status+
    ' GOOGLE='+(actual?.status??'not_found')+' EXACT_WRITE_VERIFIED='+confirmed);
  if(state.status==='created'&&!confirmed)process.exitCode=1;
}
