import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableTelemetryOutbox, type TelemetryEvent } from './operational-outbox.ts';
import { reportTelemetryHealth } from './telemetry-health.ts';
import type { StagingHealthTarget } from './staging-health-target.ts';

const folders: string[] = [];
const secret = 'offline-unit-test-secret-'.padEnd(60,'s');
const target: StagingHealthTarget = {
  url:'http://127.0.0.1:18081/', port:18081, expectedPid:87654,
};
const config = () => {
  const dir = mkdtempSync(join(tmpdir(),'telemetry-probe-')); folders.push(dir);
  return {
    businessId:randomUUID(),workerId:'synthetic-stage-worker',secret,
    endpoint:'http://127.0.0.1:18788/api/internal/telemetry',
    outboxPath:join(dir,'pending.sqlite'),
  };
};
afterEach(()=>folders.splice(0).forEach(folder =>
  rmSync(folder,{recursive:true,force:true,maxRetries:8,retryDelay:200})
));

describe('staging health signed reporter with OS listener identity checks',()=>{
  it('reports only real SQLite queue counts after two matching PID ownership checks',async()=>{
    const cfg=config(), store=new DurableTelemetryOutbox(cfg.outboxPath);
    const item: TelemetryEvent = {
      version:1,type:'call_started',eventId:randomUUID(),
      businessId:cfg.businessId,workerId:cfg.workerId,
      source:'livekit',sessionId:'synthetic-session',
      occurredAt:new Date().toISOString(),
    };
    store.enqueue(item,Date.now()-5500);store.close();
    let requests=0,inspections=0;
    const result=await reportTelemetryHealth(cfg,{
      target,inspectListener:async(port)=>{
        inspections++;expect(port).toBe(target.port);return target.expectedPid;
      },
      fetchImpl:async(url,init)=>{
        requests++;
        if(requests===1){
          expect(url).toBe(target.url);
          expect(init?.method).toBe('GET');
          expect(init?.redirect).toBe('error');
          return new Response('',{status:200});
        }
        expect(url).toBe(cfg.endpoint);
        const body=String(init?.body);
        const report=JSON.parse(body) as {
          eventId:string;type:string;health:string;source:string;
          queue:{pending:number;retryAttempts:number;dead:number;blockedByDeadLetter:number;
            oldestPendingAt:string|null;lastDeliveredAt:string|null};
        };
        expect(report).toMatchObject({
          type:'worker_heartbeat',health:'healthy',source:'livekit',
        });
        expect(report.queue).toMatchObject({
          pending:1,retryAttempts:0,dead:0,blockedByDeadLetter:0,
          lastDeliveredAt:null,
        });
        expect(report.queue.oldestPendingAt).not.toBeNull();
        expect(body).not.toContain('caller');
        const headers=init!.headers as Record<string,string>;
        expect(headers['x-hq-signature']).toBe(
          createHmac('sha256',secret).update(
            'v1\n'+headers['x-hq-timestamp']+'\n'+headers['x-hq-nonce']+'\n'+body,
          ).digest('hex'),
        );
        return Response.json({status:'accepted',eventId:report.eventId},{status:202});
      },
    });
    expect(result).toEqual({delivered:true,probe:'healthy',receipt:'accepted'});
    expect(requests).toBe(2);
    expect(inspections).toBe(2);
  });
  it('sends a signed failed-probe result only when listener identity remains stable',async()=>{
    const cfg=config();let calls=0;
    const outcome=await reportTelemetryHealth(cfg,{
      target,inspectListener:async()=>target.expectedPid,
      fetchImpl:async(_url,init)=>{
        calls++;
        if(calls===1)throw Error('mock native health timeout');
        const data=JSON.parse(String(init?.body)) as {eventId:string;health:string};
        expect(data.health).toBe('unreachable');
        return Response.json({status:'accepted',eventId:data.eventId},{status:202});
      },
    });
    expect(outcome).toEqual({delivered:true,probe:'unreachable',receipt:'accepted'});
    expect(calls).toBe(2);
  });
  it('never probes or signs an event for an unexpected OS listener PID',async()=>{
    const cfg=config();let requests=0;
    await expect(reportTelemetryHealth(cfg,{
      target,inspectListener:async()=>99999,
      fetchImpl:async()=>{requests++;return new Response('',{status:200});},
    })).rejects.toThrow('does not match');
    expect(requests).toBe(0);
  });
  it('refuses to emit if the worker PID changes after native health succeeds',async()=>{
    const cfg=config();let requests=0,check=0;
    await expect(reportTelemetryHealth(cfg,{
      target,inspectListener:async()=>++check===1?target.expectedPid:99999,
      fetchImpl:async()=>{requests++;return new Response('',{status:200});},
    })).rejects.toThrow('does not match');
    expect(requests).toBe(1); // only local native probe; NO HQ POST
  });
  it('rejects wrong health endpoints including the original worker on 8081',async()=>{
    const cfg=config();
    for(const url of ['http://127.0.0.1:8081/','https://example.com/','http://localhost:18081/']){
      await expect(reportTelemetryHealth(cfg,{
        target:{...target,url},inspectListener:async()=>target.expectedPid,
      })).rejects.toThrow('dedicated loopback');
    }
  });
  it('does not accept an unrelated HTTP 200 as proof HQ stored a heartbeat',async()=>{
    const cfg=config();let called=0;
    const result=await reportTelemetryHealth(cfg,{
      target,inspectListener:async()=>target.expectedPid,
      fetchImpl:async()=>{
        called++;
        return called===1?new Response('',{status:503}):
          new Response('<html>not a signed acknowledgement</html>',{status:200});
      },
    });
    expect(result).toMatchObject({
      delivered:false,probe:'unreachable',receipt:'unavailable',
    });
  });
});
