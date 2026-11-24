import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import {
  GooglePilot, PILOT_CALENDAR_ID, pilotTestEventLabel, readPilotConfig, readPilotState,
  type PilotCalendar,
} from './pilot.ts';

const folders:string[]=[];
function testEnv(){
  const folder=mkdtempSync(join(tmpdir(),'vvs-pilot-'));folders.push(folder);
  const root=join(folder,'repository');mkdirSync(root);
  const state=join(folder,'pilot-state.json');
  const env={
    VVS_RUNTIME_PROFILE:'google-pilot',VVS_GOOGLE_PILOT_APPROVED:'yes',
    VVS_PILOT_PROJECT_REVIEWED:'yes',VVS_PILOT_CALL_ROUTE_VERIFIED:'yes',
    VVS_PILOT_BROWSER_ROUTE_VERIFIED:'no',
    DENTAL_DEMO_MODE:'no',DENTAL_BOOKINGS_ENABLED:'no',HQ_TELEMETRY_PRODUCER_ENABLED:'no',
    DENTAL_CALENDAR_ID:PILOT_CALENDAR_ID,
    GOOGLE_CLIENT_ID:'fictional-client',GOOGLE_CLIENT_SECRET:'fictional-secret',
    GOOGLE_REFRESH_TOKEN:'fictional-token',
    LIVEKIT_URL:'wss://isolated-stage.example.test',VVS_PILOT_LIVEKIT_URL:'wss://isolated-stage.example.test',
    LIVEKIT_API_KEY:'pilot-test-key',LIVEKIT_API_SECRET:'pilot-test-secret',
    VVS_PILOT_HEALTH_PORT:'18082',
    VVS_PILOT_TEST_DATE:'2026-11-25',VVS_PILOT_TEST_TIME:'10:00',
    VVS_PILOT_STATE_PATH:state,
  };
  const prod={LIVEKIT_URL:'wss://production.example.test',LIVEKIT_API_KEY:'production-key'};
  const config=()=>readPilotConfig(env,prod,root,DateTime.fromISO('2026-11-23T07:00:00',{zone:'America/Tijuana'}));
  return {root,folder,state,env,prod,config};
}
function fakeCalendar(){
  const records=new Map<string,{start:string;end:string;status:'confirmed'|'cancelled'}>();
  const calls:{inserts:number;deletes:number}={inserts:0,deletes:0};
  const port:PilotCalendar={
    async freeBusy(start,end){
      return [...records.values()].filter(v=>v.status==='confirmed' &&
        Date.parse(v.start)<Date.parse(end) && Date.parse(v.end)>Date.parse(start))
        .map(({start,end})=>({start,end}));
    },
    async insert(id,start,end){
      calls.inserts++;
      if(records.has(id))throw Error('Duplicate ID');
      records.set(id,{start,end,status:'confirmed'});
    },
    async get(id){
      const e=records.get(id);
      return e?{id,status:e.status,start:e.start,end:e.end}:null;
    },
    async delete(id){
      calls.deletes++;
      const e=records.get(id);
      if(e)e.status='cancelled';
    },
  };
  return {port,calls,records};
}
afterEach(()=>{for(const folder of folders.splice(0))rmSync(folder,{recursive:true,force:true});});

describe('isolated Google phone-pilot safety contract (all provider APIs mocked)',()=>{
  it('distinguishes the persistent phone-test event from the auto-cleaned browser event',()=>{
    expect(pilotTestEventLabel()).toContain('(eliminar)');
    expect(pilotTestEventLabel(true)).toContain('(conservar)');
    expect(pilotTestEventLabel(true)).not.toContain('(eliminar)');
  });
  it('requires explicit approved flags, separate LiveKit project, private state path and fixed calendar',()=>{
    const x=testEnv();
    expect(x.config().calendarId).toBe(PILOT_CALENDAR_ID);
    x.env.LIVEKIT_URL=x.prod.LIVEKIT_URL;
    expect(x.config).toThrow('reviewed isolated LiveKit endpoint');
    x.env.VVS_PILOT_LIVEKIT_URL=x.env.LIVEKIT_URL;
    expect(x.config).toThrow('cannot use the existing phone agent');
    x.env.LIVEKIT_URL='wss://isolated-stage.example.test';
    x.env.VVS_PILOT_LIVEKIT_URL=x.env.LIVEKIT_URL;
    x.env.VVS_PILOT_CALL_ROUTE_VERIFIED='no';
    expect(x.config).toThrow('exactly one verified phone or browser-only route');
    x.env.VVS_PILOT_BROWSER_ROUTE_VERIFIED='yes';
    expect(x.config().calendarId).toBe(PILOT_CALENDAR_ID);
    x.env.VVS_PILOT_CALL_ROUTE_VERIFIED='yes';
    expect(x.config).toThrow('exactly one verified phone or browser-only route');
    x.env.VVS_PILOT_BROWSER_ROUTE_VERIFIED='no';
    x.env.DENTAL_CALENDAR_ID='personal@gmail.com';
    expect(x.config).toThrow('dedicated VVS Smilez');
  });
  it('does not create an event without explicit confirmation',async()=>{
    const x=testEnv(), f=fakeCalendar();
    const pilot=new GooglePilot(x.config(),f.port);
    expect(await pilot.book(false)).toBe('confirmation_required');
    expect(f.calls.inserts).toBe(0);
    expect(existsSync(x.state)).toBe(false);
  });
  it('permits only one real-provider event then verifies canceled cleanup',async()=>{
    const x=testEnv(), f=fakeCalendar();
    const config=x.config(),pilot=new GooglePilot(config,f.port);
    expect(await pilot.availability()).toBe('available');
    const outcomes=await Promise.all([pilot.book(true),pilot.book(true)]);
    expect(outcomes.sort()).toEqual(['already_used','booked']);
    expect(f.calls.inserts).toBe(1);
    expect(readPilotState(x.state)?.status).toBe('created');
    expect(readPilotState(x.state)?.writeVerifiedAt).toBeTruthy();
    expect(await pilot.availability()).toBe('already_used');
    expect(await pilot.cleanup()).toEqual({status:'cleaned',slotBusy:false});
    expect(f.calls.deletes).toBe(1);
    expect(readPilotState(x.state)?.status).toBe('cleaned');
    expect(readPilotState(x.state)?.cleanupVerifiedAt).toBeTruthy();
    expect(readPilotState(x.state)?.writeVerifiedAt).toBeTruthy();
    expect(await pilot.book(true)).toBe('already_used');
  });
  it('refuses occupied slots without consuming the one-use token',async()=>{
    const x=testEnv(), f=fakeCalendar(),config=x.config();
    f.records.set('another',{start:config.start,end:config.end,status:'confirmed'});
    const pilot=new GooglePilot(config,f.port);
    expect(await pilot.book(true)).toBe('unavailable');
    expect(f.calls.inserts).toBe(0);
    expect(existsSync(x.state)).toBe(false);
  });
  it('fails closed on uncertain provider writes and allows later cleanup only',async()=>{
    const x=testEnv(), f=fakeCalendar();
    const faulty:PilotCalendar={...f.port,insert:async(id,start,end,calendar)=>{
      await f.port.insert(id,start,end,calendar);
      throw Error('Simulated network timeout after write');
    }};
    const pilot=new GooglePilot(x.config(),faulty);
    expect(await pilot.book(true)).toBe('needs_reconciliation');
    expect(f.calls.inserts).toBe(1);
    expect(readPilotState(x.state)?.status).toBe('attempted');
    expect(readPilotState(x.state)?.writeVerifiedAt).toBeUndefined();
    expect(await pilot.book(true)).toBe('already_used');
    expect(await pilot.cleanup()).toEqual({status:'cleaned',slotBusy:false});
  });
  it('rejects past/malformed times and refuses state under repository',()=>{
    const x=testEnv();
    x.env.VVS_PILOT_TEST_DATE='2026-11-20';
    expect(x.config).toThrow('outside approved');
    x.env.VVS_PILOT_TEST_DATE='2026-11-25';
    x.env.VVS_PILOT_TEST_TIME='16:00';
    expect(x.config).toThrow('outside approved');
    x.env.VVS_PILOT_TEST_TIME='17:00';
    expect(x.config).toThrow('outside approved');
    x.env.VVS_PILOT_TEST_TIME='10:00';
    x.env.VVS_PILOT_STATE_PATH=join(x.root,'state.json');
    expect(x.config).toThrow('outside source repository');
  });
});
