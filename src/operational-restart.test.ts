import { describe,expect,it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableTelemetryOutbox } from './operational-outbox.ts';

const moduleUrl=new URL('./operational-outbox.ts',import.meta.url);
describe('outbox recovery after a real abrupt Node child-process exit',()=>{
 it('reopens the same WAL file and reclaims a crash-leased event without double delivery',()=>{
  const folder=mkdtempSync(join(tmpdir(),'vvs-process-crash-')),dbPath=join(folder,'queue.sqlite');
  const businessId=randomUUID(),eventId=randomUUID(),workerId='crash-test-worker';
  const payload={
   version:1,type:'call_started',businessId,workerId,eventId,source:'livekit',
   occurredAt:'2026-11-23T20:00:00.000Z',sessionId:'mock-abrupt-exit',
  };
  try{
   const script=[
     "import { DurableTelemetryOutbox } from "+JSON.stringify(moduleUrl.href)+";",
     "const store=new DurableTelemetryOutbox("+JSON.stringify(dbPath)+");",
     "store.enqueue("+JSON.stringify(payload)+",100);",
     "const leased=store.lease(100,50);",
     "if(!leased)process.exit(98);",
     // Simulates hard termination: no close, no network acknowledgement.
     "process.exit(9);",
   ].join('\n');
   const child=spawnSync(process.execPath,['--input-type=module','-e',script],{
    encoding:'utf8',timeout:8000,
    env:{...process.env,LIVEKIT_TEST_CAP_VERIFIED:'',LIVEKIT_TEST_SOFT_BUDGET_ACKNOWLEDGED:''},
   });
   expect(child.status).toBe(9);
   const resumed=new DurableTelemetryOutbox(dbPath);
   try{
    expect(resumed.summary()).toMatchObject({leased:1,delivered:0});
    expect(resumed.lease(149,50)).toBeNull();
    const replay=resumed.lease(151,50)!;
    expect(replay.event_id).toBe(eventId);
    expect(replay.attempts).toBe(2);
    expect(resumed.delivered(replay,155)).toBe(true);
    expect(resumed.summary()).toMatchObject({delivered:1,queued:0,leased:0});
   }finally{resumed.close();}
  }finally{rmSync(folder,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
 },20000);
});
