import { afterEach, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableTelemetryOutbox, type TelemetryEvent } from './operational-outbox.ts';
import { OperationalTelemetryProducer, hashedSessionId, readProducerConfig, signRequest } from './operational-producer.ts';

const dirs:string[]=[];
function tempDb(){
  const dir=mkdtempSync(join(tmpdir(),'vvs-telemetry-outbox-'));
  dirs.push(dir);
  return join(dir,'events.sqlite');
}
const businessId=randomUUID();
const workerId='test-livekit-worker';
const secret='synthetic-credentials-'.padEnd(48,'x');
const sessionId='lk-'+ 'a'.repeat(40);
function event(type:TelemetryEvent['type'], id=randomUUID(), sid=sessionId):TelemetryEvent {
  return {
    version:1,businessId,workerId,eventId:id,source:'livekit',sessionId:sid,
    type,occurredAt:'2026-11-23T20:00:00.000Z',
    ...(type==='call_failed'?{errorCode:'agent_session_error'}:{}),
  };
}
function config(outboxPath:string){
  return {
    businessId,workerId,secret,outboxPath,
    endpoint:'http://127.0.0.1:8787/api/internal/telemetry',
  };
}
afterEach(()=>{
  for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:100});
});

describe('SQLite WAL operational outbox',()=>{
  it('persists events before delivery and survives reopening',()=>{
    const filename=tempDb();
    const first=new DurableTelemetryOutbox(filename);
    const started=event('call_started');
    expect(first.enqueue(started,1000)).toBe('queued');
    expect(first.enqueue(started,1000)).toBe('duplicate');
    expect(()=>first.enqueue({...started,sessionId:'tampered'},1000)).toThrow('payload collision');
    expect(first.summary()).toMatchObject({queued:1,delivered:0,dead:0});
    first.close();

    const second=new DurableTelemetryOutbox(filename);
    expect(second.summary().queued).toBe(1);
    expect(second.events()[0]?.event_id).toBe(started.eventId);
    second.close();
  });

  it('enforces exactly one start and one terminal event per tenant session',()=>{
    const filename=tempDb(),store=new DurableTelemetryOutbox(filename);
    try{
      store.enqueue(event('call_started'));
      expect(()=>store.enqueue(event('call_started'))).toThrow();
      store.enqueue(event('call_completed'));
      expect(()=>store.enqueue(event('call_failed'))).toThrow();
      expect(store.summary().queued).toBe(2);
    }finally{store.close();}
  });

  it('holds a terminal event until the matching start is delivered',()=>{
    const store=new DurableTelemetryOutbox(tempDb());
    try{
      store.enqueue(event('call_started'),10);
      store.enqueue(event('call_completed'),11);
      const started=store.lease(12)!;
      expect(JSON.parse(started.payload_json).type).toBe('call_started');
      expect(store.lease(12)).toBeNull();
      expect(store.delivered(started,13)).toBe(true);
      const terminal=store.lease(14)!;
      expect(JSON.parse(terminal.payload_json).type).toBe('call_completed');
      expect(store.delivered(terminal,15)).toBe(true);
      expect(store.summary().delivered).toBe(2);
    }finally{store.close();}
  });

  it('recovers an expired process lease and rejects stale acknowledgements',()=>{
    const store=new DurableTelemetryOutbox(tempDb());
    try{
      store.enqueue(event('call_started'),100);
      const lost=store.lease(100,50)!;
      expect(store.lease(149,50)).toBeNull();
      const recovered=store.lease(151,50)!;
      expect(recovered.event_id).toBe(lost.event_id);
      expect(recovered.lease_token).not.toBe(lost.lease_token);
      expect(recovered.attempts).toBe(2);
      expect(store.delivered(lost,152)).toBe(false);
      expect(store.delivered(recovered,153)).toBe(true);
    }finally{store.close();}
  });

  it('serializes concurrent SQLite clients without double-claiming',()=>{
    const filename=tempDb();
    const a=new DurableTelemetryOutbox(filename);
    const b=new DurableTelemetryOutbox(filename);
    try{
      a.enqueue(event('call_started'),100);
      const one=a.lease(100)!;
      expect(b.lease(100)).toBeNull();
      expect(b.delivered(one,101)).toBe(true);
      expect(a.summary().delivered).toBe(1);
    }finally{a.close();b.close();}
  });

  it('preserves dead letters while blocking a terminal event behind a dead start',()=>{
    const store=new DurableTelemetryOutbox(tempDb());
    try{
      store.enqueue(event('call_started'),10);
      store.enqueue(event('call_failed'),11);
      const row=store.lease(12)!;
      expect(store.dead(row,'invalid_configuration')).toBe(true);
      expect(store.summary()).toMatchObject({dead:1,queued:1});
      expect(store.lease(1_000_000)).toBeNull();
    }finally{store.close();}
  });
});

describe('signed producer and retry',()=>{
  it('stays off by default and rejects unsafe transport',()=>{
    expect(readProducerConfig({})).toBeNull();
    const env={
      HQ_TELEMETRY_PRODUCER_ENABLED:'yes',HQ_TELEMETRY_BUSINESS_ID:businessId,
      HQ_TELEMETRY_WORKER_ID:workerId,HQ_TELEMETRY_SIGNING_SECRET:secret,
      HQ_TELEMETRY_ENDPOINT:'http://example.org/api/internal/telemetry',
    };
    expect(()=>readProducerConfig(env)).toThrow('requires HTTPS or loopback');
    expect(readProducerConfig({...env,HQ_TELEMETRY_ENDPOINT:'https://hq.example.test/api/internal/telemetry'})).not.toBeNull();
  });

  it('derives opaque stable job IDs without placing raw room, SIP or caller data in events',()=>{
    const job='AJ_TEST_999 - caller metadata must never leak';
    expect(hashedSessionId(job)).toBe(hashedSessionId(job));
    expect(hashedSessionId(job)).not.toContain('caller');
    expect(hashedSessionId(job)).toMatch(/^lk-[a-f0-9]{40}$/);
  });

  it('sends signed bytes, retains an event on 503, and succeeds on a retry after reopening',async()=>{
    const filename=tempDb(),created=event('call_started');
    let clock=100_000,requests=0;
    let payload='';
    const fetchImpl:typeof fetch=async (_url,init)=>{
      requests++;
      const headers=init?.headers as Record<string,string>;
      payload=String(init?.body);
      const expected=createHmac('sha256',secret).update(
        'v1\n'+headers['x-hq-timestamp']+'\n'+headers['x-hq-nonce']+'\n'+payload
      ).digest('hex');
      expect(headers['x-hq-signature']).toBe(expected);
      return requests===1 ? new Response('',{status:503}) :
        Response.json({status:'accepted',eventId:JSON.parse(payload).eventId},{status:202});
    };
    const first=new OperationalTelemetryProducer(config(filename),{fetchImpl,now:()=>clock});
    first.outbox.enqueue(created,clock);
    expect(await first.flushOnce()).toBe('retry');
    expect(first.outbox.summary()).toMatchObject({queued:1,delivered:0});
    const due=first.outbox.events()[0]!.next_attempt_ms;
    expect(due).toBeGreaterThan(clock);
    first.close();

    clock=due;
    const second=new OperationalTelemetryProducer(config(filename),{fetchImpl,now:()=>clock});
    expect(await second.flushOnce()).toBe('delivered');
    expect(second.outbox.summary()).toMatchObject({delivered:1,queued:0});
    expect(JSON.parse(payload)).toMatchObject({
      eventId:created.eventId,source:'livekit',type:'call_started'
    });
    second.close();
  });

  it('treats receiver 200 idempotent acknowledgement as delivered',async()=>{
    const store=new OperationalTelemetryProducer(config(tempDb()),{
      fetchImpl:async (_url,init)=>Response.json({status:'duplicate',eventId:JSON.parse(String(init?.body)).eventId},{status:200}),
    });
    try{
      store.outbox.enqueue(event('call_started'));
      expect(await store.flushOnce()).toBe('delivered');
      expect(store.outbox.summary().delivered).toBe(1);
    }finally{store.close();}
  });

  it('does not lose a request after transport timeout or invalid signature response',async()=>{
    const filename=tempDb();
    const network=new OperationalTelemetryProducer(config(filename),{
      fetchImpl:async()=>{throw Error('simulated connection reset');},
      now:()=>1_000,
    });
    network.outbox.enqueue(event('call_started'),1_000);
    expect(await network.flushOnce()).toBe('retry');
    expect(network.outbox.summary().queued).toBe(1);
    network.close();

    const bad=new OperationalTelemetryProducer(config(filename),{
      fetchImpl:async()=>new Response('',{status:401}),
      now:()=>1_000_000,
    });
    expect(await bad.flushOnce()).toBe('dead');
    expect(bad.outbox.summary().dead).toBe(1);
    bad.close();
  });

  it('rejects silent HTTP redirects and rate-limits retries without data loss',async()=>{
    const filename=tempDb();
    let redirected=false;
    const p=new OperationalTelemetryProducer(config(filename),{
      now:()=>5_000,
      fetchImpl:async (_url,init)=>{
        redirected=init?.redirect==='error';
        return new Response('',{status:429});
      },
    });
    try{
      p.outbox.enqueue(event('call_started'),5_000);
      expect(await p.flushOnce()).toBe('retry');
      expect(redirected).toBe(true);
      expect(p.outbox.events()[0]!.next_attempt_ms).toBeGreaterThan(5_000);
      expect(p.outbox.summary().queued).toBe(1);
    }finally{p.close();}
  });

  it('does not mark a misrouted HTTP 200/202 as delivered without a matching durable acknowledgement',async()=>{
    const path=tempDb();
    const store=new OperationalTelemetryProducer(config(path),{
      now:()=>9000,
      fetchImpl:async()=>Response.json({status:'accepted',eventId:randomUUID()},{status:200}),
    });
    try{
      store.outbox.enqueue(event('call_started'),9000);
      expect(await store.flushOnce()).toBe('retry');
      expect(store.outbox.summary()).toMatchObject({queued:1,delivered:0});
      expect(store.outbox.events()[0]!.next_attempt_ms).toBeGreaterThan(9000);
    }finally{store.close();}
  });

  it('reports actual dead-letter blocking and retry diagnostics',()=>{
    const store=new DurableTelemetryOutbox(tempDb());
    try{
      store.enqueue(event('call_started'),1000);
      store.enqueue(event('call_failed'),1001);
      const first=store.lease(1100)!;
      expect(store.retry(first,'transport',1200)).toBe(true);
      const second=store.lease(99999)!;
      expect(store.dead(second,'rejected')).toBe(true);
      const evidence=store.diagnostics();
      expect(evidence).toMatchObject({
        pending:1,dead:1,blockedByDeadLetter:1,retryAttempts:1,
        lastDeliveredAt:null
      });
      expect(evidence.oldestPendingAt).toBe(new Date(1001).toISOString());
    }finally{store.close();}
  });

  it('canonical signature is deterministic for the exact original JSON bytes',()=>{
    const signature=signRequest(secret,'1763930000000','a'.repeat(32),'{"version":1}');
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(signature).not.toBe(signRequest(secret,'1763930000000','a'.repeat(32),'{"version": 1}'));
  });
});
