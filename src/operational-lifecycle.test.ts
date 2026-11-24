import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { attachOperationalLifecycle } from './operational-lifecycle.ts';
import { DurableTelemetryOutbox } from './operational-outbox.ts';
import { OperationalTelemetryProducer } from './operational-producer.ts';

const folders:string[]=[];
const secret='unit-test-key-'.padEnd(48,'q');
const businessId=randomUUID();
const workerId='mocked-livekit-agent-1';
function localOutbox(){
  const folder=mkdtempSync(join(tmpdir(),'vvs-lifecycle-'));
  folders.push(folder);
  return join(folder,'outbox.sqlite');
}
function optIn(path:string){
  vi.stubEnv('HQ_TELEMETRY_PRODUCER_ENABLED','yes');
  vi.stubEnv('HQ_TELEMETRY_SIGNING_SECRET',secret);
  vi.stubEnv('HQ_TELEMETRY_BUSINESS_ID',businessId);
  vi.stubEnv('HQ_TELEMETRY_WORKER_ID',workerId);
  vi.stubEnv('HQ_TELEMETRY_OUTBOX_PATH',path);
  vi.stubEnv('HQ_TELEMETRY_ENDPOINT','http://127.0.0.1:8787/api/internal/telemetry');
}
function jobContext(){
  const callbacks:Array<()=>Promise<void>>=[];
  const ctx={
    job:{id:'AJ_MOCK_JOB_392'},
    room:{name:'NAME SHOULD NOT BE SAVED',metadata:'phone 555-555-5555'},
    addShutdownCallback:(cb:()=>Promise<void>)=>{callbacks.push(cb);},
  } as unknown as Parameters<typeof attachOperationalLifecycle>[0];
  return {ctx,callbacks};
}
afterEach(()=>{
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for(const folder of folders.splice(0))rmSync(folder,{recursive:true,force:true,maxRetries:8,retryDelay:120});
});

describe('mock LiveKit JobContext operational lifecycle',()=>{
  it('does nothing when producer is disabled',()=>{
    vi.stubEnv('HQ_TELEMETRY_PRODUCER_ENABLED','no');
    const {ctx,callbacks}=jobContext();
    expect(attachOperationalLifecycle(ctx)).toBeNull();
    expect(callbacks).toHaveLength(0);
  });

  it('records job start/completion using only opaque identifiers',async()=>{
    const path=localOutbox();
    optIn(path);
    const sent:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{
      sent.push(String(init.body));
      return Response.json({status:'accepted',eventId:JSON.parse(String(init.body)).eventId},{status:202});
    }));
    const {ctx,callbacks}=jobContext();
    const telemetry=attachOperationalLifecycle(ctx);
    expect(telemetry).not.toBeNull();
    expect(callbacks).toHaveLength(1);
    await callbacks[0]!();
    const store=new DurableTelemetryOutbox(path);
    try{
      expect(store.summary().delivered).toBe(2);
      expect(store.summary().dead).toBe(0);
    }finally{store.close();}
    expect(sent).toHaveLength(2);
    const parsed=sent.map(e=>JSON.parse(e) as {type:string;sessionId:string;source:string;businessId:string});
    expect(parsed.map(p=>p.type)).toEqual(['call_started','call_completed']);
    expect(parsed[0]!.sessionId).toBe(parsed[1]!.sessionId);
    expect(parsed[0]!.source).toBe('livekit');
    expect(parsed[0]!.businessId).toBe(businessId);
    expect(sent.join(' ')).not.toMatch(/555-555|NAME SHOULD|AJ_MOCK_JOB_392/);
  });

  it('records one terminal failure and does not add a duplicate completed event',async()=>{
    const path=localOutbox();
    optIn(path);
    const sent:Array<{type:string;errorCode?:string}>=[];
    vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{
      sent.push(JSON.parse(String(init.body)));
      return Response.json({status:'accepted',eventId:JSON.parse(String(init.body)).eventId},{status:202});
    }));
    const {ctx,callbacks}=jobContext();
    const telemetry=attachOperationalLifecycle(ctx);
    expect(telemetry).not.toBeNull();
    telemetry!.fail();
    telemetry!.fail();
    await callbacks[0]!();
    expect(sent.map(item=>item.type)).toEqual(['call_started','call_failed']);
    expect(sent[1]!.errorCode).toBe('agent_session_error');
    const store=new DurableTelemetryOutbox(path);
    try{expect(store.summary().delivered).toBe(2);}finally{store.close();}
  });

  it('keeps unsent events durable when HQ is offline, then replays them after reboot',async()=>{
    const path=localOutbox();
    optIn(path);
    vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('HQ is not running');}));
    const {ctx,callbacks}=jobContext();
    expect(attachOperationalLifecycle(ctx)).not.toBeNull();
    await callbacks[0]!();
    const saved=new DurableTelemetryOutbox(path);
    try{
      expect(saved.summary()).toMatchObject({queued:2,delivered:0});
      expect(saved.events()[0]!.attempts).toBeGreaterThan(0);
    }finally{saved.close();}

    const retrier=new OperationalTelemetryProducer({
      businessId,workerId,secret,
      outboxPath:path,endpoint:'http://127.0.0.1:8787/api/internal/telemetry',
    },{
      fetchImpl:async (_url,init)=>Response.json({status:'accepted',eventId:JSON.parse(String(init?.body)).eventId},{status:202}),
      now:()=>Date.now()+600_000,
    });
    try{
      const replay=await retrier.flushBatch(10);
      expect(replay.delivered).toBe(2);
      expect(retrier.outbox.summary()).toMatchObject({queued:0,delivered:2});
    }finally{retrier.close();}
  });
});
