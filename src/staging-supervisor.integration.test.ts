import { afterEach,describe,expect,it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DurableTelemetryOutbox, type TelemetryEvent } from './operational-outbox.ts';

const dirs:string[]=[];
const children:ChildProcessWithoutNullStreams[]=[];
afterEach(async()=>{
 for(const child of children.splice(0)){
  if(child.exitCode===null && !child.killed){
   const exited=once(child,'exit');child.kill();await exited;
  }
 }
 for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:200});
});

describe('manually activated Node supervisor in isolated offline staging',()=>{
 it('drains a durable fake LiveKit session after a separate local receiver comes up',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'vvs-supervisor-e2e-'));dirs.push(folder);
  const path=join(folder,'staging.sqlite'),businessId=randomUUID(),workerId='staging-fake-worker';
  const event:TelemetryEvent={
   version:1,businessId,workerId,eventId:randomUUID(),source:'livekit',
   occurredAt:new Date().toISOString(),type:'call_started',sessionId:'mock-job-supervised',
  };
  const db=new DurableTelemetryOutbox(path);
  db.enqueue(event,Date.now()-10_000);db.close();
  let receipts=0;
  const server=createServer(async(req,res)=>{
   const parts:Buffer[]=[];
   for await(const part of req)parts.push(Buffer.from(part));
   const raw=Buffer.concat(parts).toString('utf8');
   const content=JSON.parse(raw) as {eventId:string};
   if(content.eventId===event.eventId)receipts++;
   res.writeHead(202,{'content-type':'application/json'});
   res.end(JSON.stringify({status:'accepted',eventId:content.eventId}));
  });
  await new Promise<void>(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));
  const addr=server.address();
  if(!addr||typeof addr==='string')throw Error('No mock port');
  const root=fileURLToPath(new URL('../',import.meta.url));
  const child=spawn(process.execPath,['src/staging-supervisor.ts','--run','--drainer'],{
    cwd:root,windowsHide:true,env:{
      ...process.env,
      VVS_RUNTIME_PROFILE:'staging',
      VVS_STAGING_CREDENTIALS_CONFIRMED:'yes',
      DENTAL_DEMO_MODE:'yes',
      DENTAL_BOOKINGS_ENABLED:'no',
      GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',GOOGLE_REFRESH_TOKEN:'',
      HQ_TELEMETRY_PRODUCER_ENABLED:'yes',
      HQ_TELEMETRY_BUSINESS_ID:businessId,
      HQ_TELEMETRY_WORKER_ID:workerId,
      HQ_TELEMETRY_SIGNING_SECRET:'supervisor-test-secret-'.padEnd(48,'z'),
      HQ_TELEMETRY_ENDPOINT:'http://127.0.0.1:'+addr.port+'/api/internal/telemetry',
      HQ_TELEMETRY_OUTBOX_PATH:path,
      LIVEKIT_TEST_CAP_VERIFIED:'',
      LIVEKIT_TEST_SOFT_BUDGET_ACKNOWLEDGED:'',
    },
  });
  children.push(child);
  let delivered=false;
  try{
    for(let i=0;i<100;i++){
      const current=new DurableTelemetryOutbox(path);
      try{delivered=current.summary().delivered===1;}finally{current.close();}
      if(delivered)break;
      if(child.exitCode!==null)break;
      await new Promise(r=>setTimeout(r,100));
    }
    expect(delivered).toBe(true);
    expect(receipts).toBe(1);
  }finally{
    if(child.exitCode===null&&!child.killed){
      const finished=once(child,'exit');child.kill();await finished;
    }
    server.close();await once(server,'close');
  }
 },20000);
});
