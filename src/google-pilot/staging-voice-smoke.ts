// Silent, no-phone, no-Calendar-write LiveKit dispatch smoke test.
// Creates an ephemeral standard participant in the isolated Pilot project.
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { parse } from 'dotenv';
import { Room, RoomEvent } from '@livekit/rtc-node';

const env=parse(readFileSync('.env.google-pilot.local','utf8'));
const stage=parse(readFileSync('.env.google-staging.local','utf8'));
// This smoke test sends no appointment requests or confirmation messages.
if(!['yes','no'].includes(stage.VVS_STAGING_ALLOW_WRITES ?? '') ||
   stage.VVS_STAGING_BROWSER_ONLY !== 'yes')
  throw Error('Requires explicit isolated browser staging configuration');
if(env.VVS_PILOT_CALL_ROUTE_VERIFIED !== 'no' || env.VVS_PILOT_BROWSER_ROUTE_VERIFIED !== 'yes')
  throw Error('Diagnostic requires isolated browser-only project');
const url=new URL(env.LIVEKIT_URL!);
if(url.protocol !== 'wss:' || !url.hostname.endsWith('.livekit.cloud'))
  throw Error('Unexpected LiveKit host');
const roomName='vvs-stage-smoke-'+randomBytes(6).toString('hex');
function jwt(identity:string,grant:Record<string,unknown>) {
  const enc=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const head=enc({alg:'HS256',typ:'JWT'});
  const now=Math.floor(Date.now()/1000);
  const payload=enc({iss:env.LIVEKIT_API_KEY,sub:identity,iat:now-10,nbf:now-10,
    exp:now+120,video:grant});
  const input=head+'.'+payload;
  const sig=createHmac('sha256',env.LIVEKIT_API_SECRET!).update(input).digest('base64url');
  return input+'.'+sig;
}
const participantToken=jwt('synthetic-browser-participant',{
  roomJoin:true,room:roomName,canSubscribe:true,canPublish:false,
});
const adminToken=jwt('staging-diagnostic-admin',{roomAdmin:true,room:roomName});
const rtc=new Room();
let sawAgent=false;
rtc.on(RoomEvent.ParticipantConnected, p=>{
  if(p.identity.startsWith('agent-')) {
    sawAgent=true;
    console.log('STAGING_SMOKE_AGENT_JOINED=True');
  }
});
try {
  await rtc.connect(env.LIVEKIT_URL!,participantToken,{autoSubscribe:true,dynacast:false});
  console.log('STAGING_SMOKE_STANDARD_PARTICIPANT_CONNECTED=True');
  const res=await fetch('https://'+url.hostname+'/twirp/livekit.AgentDispatchService/CreateDispatch',{
    method:'POST',
    headers:{Authorization:'Bearer '+adminToken,'Content-Type':'application/json'},
    body:JSON.stringify({room:roomName,agent_name:'vvs-calendar-staging'}),
    signal:AbortSignal.timeout(12000),
  });
  if(!res.ok) throw Error('Dispatch failed HTTP '+res.status);
  console.log('STAGING_SMOKE_DISPATCH_ACCEPTED=True');
  const started=Date.now();
  while(!sawAgent && Date.now()-started<25000)
    await new Promise(r=>setTimeout(r,500));
  console.log('STAGING_SMOKE_AGENT_JOINED_CONFIRMED='+sawAgent);
  if(!sawAgent)process.exitCode=1;
  if(sawAgent)await new Promise(r=>setTimeout(r,5000));
}finally {
  await rtc.disconnect();
  console.log('STAGING_SMOKE_PARTICIPANT_DISCONNECTED=True');
}
// The LiveKit native RTC runtime can keep CLI tests alive after disconnect.
// This script has no remaining work or Calendar writes: terminate test-only process.
process.exit(Number(process.exitCode ?? 0));
