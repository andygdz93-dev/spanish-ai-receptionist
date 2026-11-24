// Explicit operator reconciliation after a call/crash. Never auto-books.
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { DateTime } from 'luxon';
import { GooglePilot, googlePilotCalendar, readPilotConfig, readPilotState } from './pilot.ts';
const action=process.argv[2];
if(!['status','cleanup'].includes(action??'')){
  console.log('Usage: node src/google-pilot/reconcile.ts status|cleanup');
  process.exit(2);
}
const env=parse(readFileSync('.env.google-pilot.local','utf8'));
const prod=parse(readFileSync('.env.local','utf8'));
// Cleanup may run after the scheduled test day; it must not require a future slot.
const config=readPilotConfig(env,prod,process.cwd(),DateTime.now(),true);
const pilot=new GooglePilot(config,googlePilotCalendar(config));
const state=readPilotState(config.statePath);
if(action==='status'){
  console.log('PILOT_EVENT_STATE=',state?.status??'unused');
  console.log('GOOGLE_WRITE_VERIFIED=',Boolean(state?.writeVerifiedAt));
  console.log('GOOGLE_CLEANUP_VERIFIED=',Boolean(state?.cleanupVerifiedAt));
  if(state){
    const remote=await pilot.cal.get(state.eventId,config.calendarId);
    console.log('GOOGLE_EVENT_STATUS=',remote?.status??(remote?'confirmed':'not_found'));
    console.log('LOCAL_EVENT_MATCH=',remote?.id===state.eventId);
  }
}else{
  const result=await pilot.cleanup();
  console.log('PILOT_CLEANUP=',result.status);
  console.log('TEST_SLOT_BUSY=',result.slotBusy===null?'unknown':result.slotBusy);
  if(result.status==='needs_review')process.exitCode=1;
}
