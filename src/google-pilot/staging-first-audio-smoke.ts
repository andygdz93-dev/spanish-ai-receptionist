// Isolated LiveKit probe: measures when the synthetic remote listener receives
// the first non-silent decoded PCM frame. Not a browser loudspeaker measurement.
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { AudioStream, Room, RoomEvent, TrackKind, dispose } from '@livekit/rtc-node';

const env=parse(readFileSync('.env.google-pilot.local','utf8'));
const stage=parse(readFileSync('.env.google-staging.local','utf8'));
if(stage.VVS_STAGING_BROWSER_ONLY!=='yes'||
   env.VVS_PILOT_CALL_ROUTE_VERIFIED!=='no'||
   env.VVS_PILOT_BROWSER_ROUTE_VERIFIED!=='yes')throw Error('Isolated staging only');
const url=new URL(env.LIVEKIT_URL!);
if(url.protocol!=='wss:'||!url.hostname.endsWith('.livekit.cloud'))
  throw Error('Unexpected LiveKit host');
const roomName='vvs-first-audio-'+randomBytes(6).toString('hex');
function token(identity:string,grant:Record<string,unknown>):string{
  const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const now=Math.floor(Date.now()/1000),head=encode({alg:'HS256',typ:'JWT'});
  const payload=encode({iss:env.LIVEKIT_API_KEY,sub:identity,iat:now-10,
    exp:now+120,video:grant});
  const body=head+'.'+payload;
  return body+'.'+createHmac('sha256',env.LIVEKIT_API_SECRET!).update(body).digest('base64url');
}
const rtc=new Room();
let connectedAt=0,dispatchStartedAt=0,agentJoinedAt:number|null=null;
let subscribedAt:number|null=null,firstFrameAt:number|null=null,firstSpeechAt:number|null=null;
let audioTrackObserved=false;
rtc.on(RoomEvent.ParticipantConnected,p=>{
  if(p.identity.startsWith('agent-')){
    agentJoinedAt=performance.now();
    console.log('FIRST_AUDIO_AGENT_JOINED=true');
  }
});
rtc.on(RoomEvent.TrackSubscribed,(track,_publication,participant)=>{
  if(!participant.identity.startsWith('agent-')||track.kind!==TrackKind.KIND_AUDIO)return;
  subscribedAt=performance.now();
  audioTrackObserved=true;
  const stream=new AudioStream(track,16000,1);
  void (async()=>{
    for await(const frame of stream){
      const now=performance.now();
      if(firstFrameAt===null)firstFrameAt=now;
      const pcm=frame.data;
      // Sample a bounded subset and ignore digital silence; no audio is saved.
      for(let i=0;i<pcm.length;i+=8){
        if(Math.abs(pcm[i]??0)>200){
          firstSpeechAt=now;
          console.log('FIRST_AUDIO_NON_SILENT_FRAME_OBSERVED=true');
          return;
        }
      }
    }
  })().catch(e=>console.warn('FIRST_AUDIO_STREAM_ERROR',e.name));
});
try{
  await rtc.connect(env.LIVEKIT_URL!,token('staging-first-audio-synthetic',{
    roomJoin:true,room:roomName,canSubscribe:true,canPublish:false,
  }),{autoSubscribe:true,dynacast:false});
  connectedAt=performance.now();
  dispatchStartedAt=performance.now();
  const res=await fetch('https://'+url.hostname+'/twirp/livekit.AgentDispatchService/CreateDispatch',{
    method:'POST',
    headers:{Authorization:'Bearer '+token('staging-first-audio-admin',{
      roomAdmin:true,room:roomName,
    }),'Content-Type':'application/json'},
    body:JSON.stringify({room:roomName,agent_name:'vvs-calendar-staging'}),
    signal:AbortSignal.timeout(12000),
  });
  if(!res.ok)throw Error('Dispatch HTTP '+res.status);
  console.log('FIRST_AUDIO_DISPATCH_ACCEPTED=true');
  for(let i=0;i<80&&firstSpeechAt===null;i++)
    await new Promise(r=>setTimeout(r,500));
  const ms=(v:number|null,ref=dispatchStartedAt)=>
    v===null?'NOT_OBSERVED':String(Math.round(v-ref));
  console.log('FIRST_AUDIO_AGENT_JOIN_MS='+ms(agentJoinedAt));
  console.log('FIRST_AUDIO_TRACK_SUBSCRIBED_MS='+ms(subscribedAt));
  console.log('FIRST_AUDIO_FIRST_DECODED_FRAME_MS='+ms(firstFrameAt));
  console.log('FIRST_AUDIO_FIRST_NON_SILENT_PCM_MS='+ms(firstSpeechAt));
  console.log('FIRST_AUDIO_CONNECT_TO_NON_SILENT_PCM_MS='+ms(firstSpeechAt,connectedAt));
  console.log('FIRST_AUDIO_REMOTE_AUDIO_TRACK_OBSERVED='+audioTrackObserved);
  if(firstSpeechAt===null)process.exitCode=1;
}finally{
  await rtc.disconnect();
  await dispose();
}
process.exit(Number(process.exitCode??0));
