// Full LiveKit text-to-Calendar staging test. Only synthetic data; never phones or real patients.
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { Room, RoomEvent } from '@livekit/rtc-node';
import { StagingScheduler } from './staging-scheduler.ts';
import { googlePilotCalendar, readPilotState } from './pilot.ts';

const date='2026-11-30', time='11:00'; // isolated synthetic test slot
const isolated=parse(readFileSync('.env.google-pilot.local','utf8'));
const original=parse(readFileSync('.env.local','utf8'));
const stage=parse(readFileSync('.env.google-staging.local','utf8'));
if (stage.VVS_STAGING_ALLOW_WRITES!=='yes' || stage.VVS_STAGING_BROWSER_ONLY!=='yes')
  throw Error('Staging synthetic writes must be separately enabled');
const scheduler=new StagingScheduler({isolatedEnv:isolated,originalEnv:original,
  stagingEnv:stage,root:process.cwd()});
const slot=scheduler.auditPath(date,time);
if (existsSync(slot)) throw Error('Slot already attempted; refuse to retry a used test');
const status=await scheduler.availability(date,time);
console.log('E2E_CALENDAR_PREFLIGHT_STATUS='+status);
if(status!=='available') throw Error('Synthetic test slot not available');
const baseUrl=new URL(isolated.LIVEKIT_URL!);
if(baseUrl.protocol!=='wss:' || !baseUrl.hostname.endsWith('.livekit.cloud'))
  throw Error('Expected isolated LiveKit Cloud URL');
const room='vvs-staging-e2e-'+randomBytes(6).toString('hex');
const jwt=(identity:string,video:Record<string,unknown>)=>{
  const enc=(j:unknown)=>Buffer.from(JSON.stringify(j)).toString('base64url');
  const now=Math.floor(Date.now()/1000);
  const h=enc({typ:'JWT',alg:'HS256'});
  const b=enc({iss:isolated.LIVEKIT_API_KEY,sub:identity,iat:now-10,
    exp:now+180,video});
  const msg=h+'.'+b;
  return msg+'.'+createHmac('sha256',isolated.LIVEKIT_API_SECRET!).update(msg).digest('base64url');
};
const roomClient=new Room();
let joined=false;
const transcripts:string[]=[];
roomClient.registerTextStreamHandler('lk.transcription', async(reader,participant)=>{
  try{
    const text=await reader.readAll();
    if(participant.identity.startsWith('agent-')){
      transcripts.push(text);
      console.log('E2E_AGENT_TRANSCRIPT='+text.slice(0,450).replace(/\s+/g,' '));
    }
  }catch(e){console.warn('E2E_TRANSCRIPT_ERROR',String(e).slice(0,140));}
});
roomClient.on(RoomEvent.ParticipantConnected,p=>{
  if(p.identity.startsWith('agent-')){joined=true;console.log('E2E_AGENT_JOINED=True');}
});
let created=false;
try {
  await roomClient.connect(isolated.LIVEKIT_URL!,jwt('stage-e2e-visitor',{
    roomJoin:true,room,canSubscribe:true,canPublish:false,canPublishData:true,
  }),{autoSubscribe:true,dynacast:false});
  const resp=await fetch('https://'+baseUrl.hostname+'/twirp/livekit.AgentDispatchService/CreateDispatch',{
    method:'POST',
    headers:{Authorization:'Bearer '+jwt('stage-e2e-controller',{roomAdmin:true,room}),
      'Content-Type':'application/json'},
    body:JSON.stringify({room,agent_name:'vvs-calendar-staging'}),
    signal:AbortSignal.timeout(15000),
  });
  if(!resp.ok)throw Error('Dispatch HTTP '+resp.status);
  const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
  for(let i=0;i<50&&!joined;i++)await wait(200);
  if(!joined)throw Error('Agent never joined');
  await wait(1500);
  await roomClient.localParticipant!.sendText(
    'Hola. Quiero comprobar disponibilidad de una cita técnica de prueba para el lunes 30 de noviembre de 2026 a las once de la mañana, hora de Tijuana. No es una cita de paciente real.',
    {topic:'lk.chat'});
  console.log('E2E_REQUEST_SENT=True');
  for(let i=0;i<40;i++){
    if(transcripts.join(' ').toLowerCase().match(/confirm|disponib/)) break;
    await wait(700);
  }
  const preConfirmation=transcripts.join(' ').toLowerCase();
  console.log('E2E_TRANSCRIPT_COUNT_PRE_CONFIRM='+transcripts.length);
  if(/hora exacta|qué hora|que hora|a qué hora/.test(preConfirmation))
    throw Error('Assistant redundantly requested the hour already provided');
  await roomClient.localParticipant!.sendText(
    'Sí, confirmo explícitamente la creación de ese evento técnico de prueba para el lunes 30 de noviembre a las 11 de la mañana. Quiero guardarlo en Google Calendar y conservarlo después de terminar la sesión. Sin datos de pacientes.',
    {topic:'lk.chat'});
  console.log('E2E_EXPLICIT_CONFIRMATION_SENT=True');
  for(let i=0;i<75;i++) {
    if(existsSync(slot)){
      const state=readPilotState(slot);
      if(state?.status==='created'){created=true;break;}
      if(state?.status==='attempted' && i>50)break;
    }
    await wait(850);
  }
  const ledger=existsSync(slot)?readPilotState(slot):null;
  console.log('E2E_BOOKING_LEDGER_STATUS='+(ledger?.status??'unused'));
  console.log('E2E_AGENT_TRANSCRIPT_COUNT='+transcripts.length);
  if(!created)throw Error('No confirmed Calendar write through LiveKit text conversation');
} finally {
  await roomClient.disconnect();
  console.log('E2E_LIVEKIT_SESSION_ENDED=True');
}
const saved=readPilotState(slot);
if(saved?.status!=='created'||!saved.writeVerifiedAt)
  throw Error('No durable confirmed appointment after hangup');
const calendar=googlePilotCalendar({
  ...(() => {
    // Existing scheduler validates the slot and path; use an independently parsed configuration.
    return {
      calendarId:isolated.DENTAL_CALENDAR_ID!,
      clientId:isolated.GOOGLE_CLIENT_ID!,clientSecret:isolated.GOOGLE_CLIENT_SECRET!,
      refreshToken:isolated.GOOGLE_REFRESH_TOKEN!,start:saved.start,end:saved.end,date,time,
      statePath:slot,livekitUrl:isolated.LIVEKIT_URL!,livekitKey:isolated.LIVEKIT_API_KEY!,
      livekitSecret:isolated.LIVEKIT_API_SECRET!,healthPort:18084,
    };
  })(),
},{retainAfterCall:true});
const result=await calendar.get(saved.eventId,isolated.DENTAL_CALENDAR_ID!);
console.log('E2E_EVENT_CONFIRMED_AFTER_SESSION='+(result?.status==='confirmed'));
console.log('E2E_EVENT_ID_MATCH='+(result?.id===saved.eventId));
if(result?.status!=='confirmed'||result.id!==saved.eventId)throw Error('Google event not retained');
console.log('E2E_SUCCESS_PERSISTENT_SYNTHETIC_BOOKING=True');
// Exact Google event readback is complete; free native LiveKit RTC resources.
process.exit(0);
