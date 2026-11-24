import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { StagingScheduler, type StageOptions } from './staging-scheduler.ts';
import { PILOT_CALENDAR_ID, type PilotCalendar } from './pilot.ts';

const folders: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'vvs-repeatable-')); folders.push(dir);
  const root = join(dir, 'repo'); mkdirSync(root);
  const audit = join(dir, 'private-stage'); mkdirSync(audit);
  const events = new Map<string,{start:string;end:string;status:'confirmed'|'cancelled'}>();
  const calls = { inserts:0, deletes:0 };
  const calendar: PilotCalendar = {
    async freeBusy(start,end) {
      return [...events.values()]
        .filter(x => x.status==='confirmed' && Date.parse(x.start)<Date.parse(end) &&
          Date.parse(x.end)>Date.parse(start))
        .map(x => ({start:x.start,end:x.end}));
    },
    async insert(id,start,end) {
      calls.inserts++;
      events.set(id,{start,end,status:'confirmed'});
    },
    async get(id) {
      const e=events.get(id);
      return e ? {id,...e} : null;
    },
    async delete(id) {
      calls.deletes++;
      const e=events.get(id); if(e)e.status='cancelled';
    },
  };
  const isolated: NodeJS.ProcessEnv = {
    VVS_RUNTIME_PROFILE:'google-pilot', VVS_GOOGLE_PILOT_APPROVED:'yes',
    VVS_PILOT_PROJECT_REVIEWED:'yes',VVS_PILOT_CALL_ROUTE_VERIFIED:'no',
    VVS_PILOT_BROWSER_ROUTE_VERIFIED:'yes',
    DENTAL_DEMO_MODE:'no', DENTAL_BOOKINGS_ENABLED:'no',
    HQ_TELEMETRY_PRODUCER_ENABLED:'no', DENTAL_CALENDAR_ID:PILOT_CALENDAR_ID,
    GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',
    GOOGLE_REFRESH_TOKEN:'test-refresh',LIVEKIT_URL:'wss://browser-stage.example.test',
    VVS_PILOT_LIVEKIT_URL:'wss://browser-stage.example.test',
    LIVEKIT_API_KEY:'stage-key',LIVEKIT_API_SECRET:'stage-secret',
    VVS_PILOT_HEALTH_PORT:'18082',
  };
  const stage: NodeJS.ProcessEnv = {
    VVS_STAGING_APPROVED:'yes',VVS_STAGING_BROWSER_ONLY:'yes',
    VVS_STAGING_ALLOW_WRITES:'yes',VVS_STAGING_AUDIT_DIR:audit,
  };
  const options: StageOptions = {
    isolatedEnv:isolated, stagingEnv:stage,
    originalEnv:{LIVEKIT_URL:'wss://original.example.test',LIVEKIT_API_KEY:'original-key'},
    root, now:()=>DateTime.fromISO('2026-11-23T12:00:00',{zone:'America/Tijuana'}),
    calendarFactory:()=>calendar,
  };
  const scheduler=()=>new StagingScheduler(options);
  return { dir, root, audit, events, calls, isolated, stage, options, scheduler };
}
afterEach(()=>{for(const dir of folders.splice(0)) rmSync(dir,{force:true,recursive:true});});

describe('repeatable, isolated, persistent staging scheduling',()=>{
  it('books different future slots, verifies writes, and NEVER deletes on hangup',async()=>{
    const x=fixture(), s=x.scheduler();
    expect(await s.availability('2026-11-25','10:00')).toBe('available');
    const a=await s.book('2026-11-25','10:00',true);
    expect(a).toMatchObject({status:'booked',testOnly:true,realPatientBooking:false,
      savedInGoogleCalendar:true,retainedAfterHangup:true});
    expect(JSON.parse(readFileSync(s.auditPath('2026-11-25','10:00'),'utf8')).status).toBe('created');
    expect(await s.availability('2026-11-25','10:00')).toBe('already_used');
    expect(await s.book('2026-11-25','10:00',true)).toMatchObject({status:'already_used'});
    expect((await s.book('2026-11-26','11:00',true)).status).toBe('booked');
    expect(x.calls).toEqual({inserts:2,deletes:0});
    expect([...x.events.values()].every(e=>e.status==='confirmed')).toBe(true);
  });

  it('requires explicit spoken confirmation and write permission',async()=>{
    const x=fixture(),s=x.scheduler();
    expect((await s.book('2026-11-25','10:00',false)).status).toBe('confirmation_required');
    x.stage.VVS_STAGING_ALLOW_WRITES='no';
    expect((await s.book('2026-11-25','10:00',true)).status).toBe('disabled');
    expect(x.calls.inserts).toBe(0);
    expect(existsSync(join(x.audit,'2026-11-25_1000.json'))).toBe(false);
  });

  it('rejects occupied, past and invalid slots without writing',async()=>{
    const x=fixture(),s=x.scheduler();
    const first=s.auditPath('2026-11-25','10:00');
    const b=new Date('2026-11-25T18:00:00Z');
    x.events.set('busy',{start:b.toISOString(),end:new Date(b.getTime()+75*60000).toISOString(),status:'confirmed'});
    expect(await s.availability('2026-11-25','10:00')).toBe('busy');
    expect((await s.book('2026-11-25','10:00',true)).status).toBe('unavailable');
    expect(existsSync(first)).toBe(false);
    await expect(s.availability('2026-11-23','10:00')).rejects.toThrow('outside approved');
    await expect(s.availability('../private','10:00')).rejects.toThrow('Use date');
    await expect(s.availability('2026-11-25','10:15')).rejects.toThrow('outside approved');
    expect(x.calls.inserts).toBe(0);
  });

  it('fails closed if provider write is uncertain and blocks duplicate retries',async()=>{
    const x=fixture(), real=x.options.calendarFactory!;
    x.options.calendarFactory=(c)=>({
      ...real(c),insert:async(id,start,end,cal)=>{
        await real(c).insert(id,start,end,cal);
        throw Error('network timeout after insert');
      },
    });
    const s=x.scheduler();
    expect((await s.book('2026-11-25','10:00',true)).status).toBe('needs_reconciliation');
    expect((await s.book('2026-11-25','10:00',true)).status).toBe('already_used');
    expect(x.calls).toEqual({inserts:1,deletes:0});
  });

  it('enforces browser-only routing and private staging approval',()=>{
    const x=fixture();
    x.stage.VVS_STAGING_APPROVED='no';
    expect(x.scheduler).toThrow('explicitly approved');
    x.stage.VVS_STAGING_APPROVED='yes';
    x.isolated.VVS_PILOT_CALL_ROUTE_VERIFIED='yes';
    expect(x.scheduler).toThrow('Only the isolated browser');
  });
});
