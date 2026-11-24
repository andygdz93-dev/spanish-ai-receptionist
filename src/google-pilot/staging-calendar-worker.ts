// Separate real-time voice from Google SDK/OAuth/Calendar CPU and network activity.
// This worker thread never receives patient data; only synthetic stage date/time.
import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { google } from 'googleapis';
import { StagingScheduler } from './staging-scheduler.ts';

type Req={ id:number; action:'availability'|'book'; date:string; time:string; confirmed?:boolean };
const port=parentPort;
if(!port)throw Error('The staging Calendar backend requires an isolated Worker thread');

const ready=(async()=>{
  const isolated=parse(readFileSync('.env.google-pilot.local','utf8'));
  const original=parse(readFileSync('.env.local','utf8'));
  const staging=parse(readFileSync('.env.google-staging.local','utf8'));
  const scheduler=new StagingScheduler({
    isolatedEnv:isolated,originalEnv:original,stagingEnv:staging,root:process.cwd(),
  });
  if (!isolated.GOOGLE_REFRESH_TOKEN) throw Error('Missing staging OAuth token');
  const auth=new google.auth.OAuth2(isolated.GOOGLE_CLIENT_ID,isolated.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({refresh_token:isolated.GOOGLE_REFRESH_TOKEN});
  const identity=await google.oauth2({version:'v2',auth}).userinfo.get();
  if(identity.data.email?.toLowerCase()!=='andygdz653@gmail.com')
    throw Error('Staging OAuth account identity mismatch');
  port.postMessage({type:'ready'});
  return scheduler;
})();
ready.catch(()=>port.postMessage({type:'fatal',reason:'staging_calendar_preflight_failed'}));

port.on('message',async(raw:unknown)=>{
  const req=raw as Req;
  if(!req||!Number.isInteger(req.id))return;
  const started=Date.now();
  try {
    const scheduler=await ready;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(req.date)||!/^\d{2}:\d{2}$/.test(req.time))
      throw Error('invalid_slot');
    if(req.action==='availability'){
      const status=await scheduler.availability(req.date,req.time);
      port.postMessage({type:'response',id:req.id,
        result:{status,date:req.date,time:req.time,testOnly:true},elapsedMs:Date.now()-started});
    }else if(req.action==='book'){
      const result=await scheduler.book(req.date,req.time,req.confirmed===true);
      port.postMessage({type:'response',id:req.id,result,elapsedMs:Date.now()-started});
    }else {
      port.postMessage({type:'response',id:req.id,result:{status:'invalid_action'},elapsedMs:0});
    }
  } catch(error){
    const message=String((error as Error).message??'');
    const status=message.includes('outside approved')||
      message.includes('Use date')||message==='invalid_slot'?'invalid_slot':'calendar_error';
    port.postMessage({type:'response',id:req.id,
      result:{status,date:req.date,time:req.time,testOnly:true,realPatientBooking:false},
      elapsedMs:Date.now()-started});
  }
});
