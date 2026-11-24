// Read-only, text-driven RTC response benchmark. This intentionally bypasses STT;
// DO NOT label text-to-first-audio results as voice end-to-end latency.
import {createHmac,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parse} from 'dotenv';
import {AudioStream,Room,RoomEvent,TrackKind,dispose} from '@livekit/rtc-node';

const env=parse(readFileSync('.env.google-pilot.local','utf8'));
const stage=parse(readFileSync('.env.google-staging.local','utf8'));
if(stage.VVS_STAGING_BROWSER_ONLY!=='yes'||stage.VVS_STAGING_ALLOW_WRITES!=='no'||
  env.VVS_PILOT_CALL_ROUTE_VERIFIED!=='no'||env.VVS_PILOT_BROWSER_ROUTE_VERIFIED!=='yes')
  throw Error('Sequential benchmark requires browser-only, Calendar writes disabled');
const rounds=Number(process.argv[2]??4),label=process.argv[3]??'baseline';
if(!Number.isInteger(rounds)||rounds<1||rounds>6||!/^[a-z0-9-]{1,30}$/.test(label))
  throw Error('Usage: text-benchmark [rooms 1..6] [label]');
const url=new URL(env.LIVEKIT_URL!);
if(url.protocol!=='wss:'||!url.hostname.endsWith('.livekit.cloud'))
  throw Error('Unknown LiveKit endpoint');
function jwt(identity:string,grant:Record<string,unknown>):string{
  const enc=(j:unknown)=>Buffer.from(JSON.stringify(j)).toString('base64url');
  const now=Math.floor(Date.now()/1000);
  const a=enc({alg:'HS256',typ:'JWT'});
  const b=enc({iss:env.LIVEKIT_API_KEY,sub:identity,iat:now-10,exp:now+180,video:grant});
  const str=a+'.'+b;
  return str+'.'+createHmac('sha256',env.LIVEKIT_API_SECRET!).update(str).digest('base64url');
}
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const questions=[
 '¿Cuál es el horario de las citas técnicas de prueba?',
 '¿En qué zona horaria trabajan?',
 '¿Pueden confirmar citas clínicas reales en esta sesión de prueba?',
];
type Turn={room:number;question:number;firstAudioMs:number|null;words:number;shortEnough:boolean};
const samples:Turn[]=[];
let roomsFailed=0;
for(let run=0;run<rounds;run++){
  const name='vvs-text-latency-'+randomBytes(6).toString('hex');
  const room=new Room();
  let greetingAt:number|null=null,lastAudibleAt:number|null=null;
  let awaiting=false,firstResponseAt:number|null=null;
  const transcripts:string[]=[];
  room.registerTextStreamHandler('lk.transcription',async(reader,participant)=>{
    try{
      const words=await reader.readAll();
      if(participant.identity.startsWith('agent-'))transcripts.push(words);
    }catch{ /* Synthetic room may close while an async transcript is streaming. */ }
  });
  room.on(RoomEvent.TrackSubscribed,(track,_publication,participant)=>{
    if(track.kind!==TrackKind.KIND_AUDIO||!participant.identity.startsWith('agent-'))return;
    const stream=new AudioStream(track,16000,1);
    void(async()=>{
      for await(const frame of stream){
        let audible=false;
        for(let i=0;i<frame.data.length;i+=8)
          if(Math.abs(frame.data[i]??0)>200){audible=true;break;}
        if(!audible)continue;
        const tick=performance.now();
        if(greetingAt===null)greetingAt=tick;
        lastAudibleAt=tick;
        if(awaiting&&firstResponseAt===null)firstResponseAt=tick;
      }
    })().catch(()=>{ /* Stream closes on normal disconnect. */ });
  });
  try{
    await room.connect(env.LIVEKIT_URL!,jwt('stage-text-'+run,{
      roomJoin:true,room:name,canPublish:false,canPublishData:true,canSubscribe:true,
    }),{autoSubscribe:true,dynacast:false});
    const a=await fetch('https://'+url.hostname+'/twirp/livekit.AgentDispatchService/CreateDispatch',{
      method:'POST',
      headers:{Authorization:'Bearer '+jwt('stage-text-admin',{roomAdmin:true,room:name}),
        'Content-Type':'application/json'},
      body:JSON.stringify({room:name,agent_name:'vvs-calendar-staging'}),
      signal:AbortSignal.timeout(14000),
    });
    if(!a.ok)throw Error('Dispatch HTTP '+a.status);
    const started=Date.now();
    while(greetingAt===null&&Date.now()-started<22000)await pause(100);
    if(greetingAt===null)throw Error('No greeting audio');
    async function waitQuiet(ms:number,max:number){
      const deadline=Date.now()+max;
      while((lastAudibleAt===null||performance.now()-lastAudibleAt<ms)&&Date.now()<deadline)
        await pause(120);
      if(lastAudibleAt===null||performance.now()-lastAudibleAt<ms)
        throw Error('Agent speech did not become quiet');
    }
    await waitQuiet(1300,24000);
    for(let q=0;q<questions.length;q++){
      await pause(200);
      const transcriptBefore=transcripts.length;
      awaiting=true;
      firstResponseAt=null;
      const sentAt=performance.now();
      await room.localParticipant!.sendText(questions[q]!,{topic:'lk.chat'});
      const timeout=Date.now()+16000;
      while(firstResponseAt===null&&Date.now()<timeout)await pause(100);
      if(firstResponseAt===null){
        const failure:Turn={room:run+1,question:q+1,firstAudioMs:null,words:0,shortEnough:false};
        samples.push(failure);awaiting=false;
        console.log('TEXT_BENCH_SAMPLE='+JSON.stringify(failure));
        throw Error('No TTS audio response in time');
      }
      const latency=Math.round(firstResponseAt-sentAt);
      await waitQuiet(1250,22000);
      await pause(350);
      awaiting=false;
      const spokenText=transcripts.slice(transcriptBefore).join(' ').trim();
      const wordCount=spokenText.split(/\s+/).filter(Boolean).length;
      const sample:Turn={room:run+1,question:q+1,firstAudioMs:latency,words:wordCount,
        shortEnough:wordCount>0&&wordCount<=30};
      samples.push(sample);
      console.log('TEXT_BENCH_SAMPLE='+JSON.stringify(sample));
    }
  }catch(e){
    roomsFailed++;
    console.log('TEXT_BENCH_ROOM_ERROR='+JSON.stringify({room:run+1,error:(e as Error).message.slice(0,140)}));
  }finally{
    try{await room.disconnect();}catch{ /* Normal remote teardown race. */ }
    await pause(350);
  }
}
const sorted=samples.map(x=>x.firstAudioMs)
  .filter((v):v is number=>v!==null&&v>=0).sort((a,b)=>a-b);
const nearestRank=(p:number)=>
  sorted.length?sorted[Math.max(0,Math.ceil(p*sorted.length)-1)]:null;
const summary={label,rooms:rounds,turns:samples.length,
  responses:sorted.length,noResponse:samples.filter(x=>x.firstAudioMs===null).length,
  failedRooms:roomsFailed,p50Ms:nearestRank(.5),p95Ms:nearestRank(.95),
  transcriptCoverage:samples.filter(x=>x.words>0).length,
  over30Words:samples.filter(x=>x.words>30).length,
  samples,
};
const path=join(tmpdir(),'vvs-smilez-text-benchmark-'+label+'.json');
writeFileSync(path,JSON.stringify(summary,null,2));
console.log('TEXT_BENCH_SUMMARY='+JSON.stringify(summary));
console.log('TEXT_BENCH_FILE='+path);
await dispose();
process.exit(sorted.length<3?1:0);
