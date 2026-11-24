// Synthetic Spanish audio benchmark. No SIP, patient details, or booking consent.
// Measures decoded, non-silent agent audio arrival after user PCM playout,
// not acoustic speaker output; runs sequentially to avoid load confounds.
import {createHmac,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parse} from 'dotenv';
import {
  AudioSource,AudioFrame,AudioStream,LocalAudioTrack,TrackPublishOptions,
  TrackSource,TrackKind,Room,RoomEvent,dispose,
} from '@livekit/rtc-node';

const env=parse(readFileSync('.env.google-pilot.local','utf8'));
const stage=parse(readFileSync('.env.google-staging.local','utf8'));
if(stage.VVS_STAGING_BROWSER_ONLY!=='yes'||stage.VVS_STAGING_ALLOW_WRITES!=='no'||
  env.VVS_PILOT_CALL_ROUTE_VERIFIED!=='no'||env.VVS_PILOT_BROWSER_ROUTE_VERIFIED!=='yes')
  throw Error('Synthetic benchmark requires staging browser only and Calendar writes disabled');
const rounds=Number(process.argv[2]??3);
if(!Number.isInteger(rounds)||rounds<1||rounds>6)throw Error('1 to 6 sessions per benchmark');
const label=process.argv[3]??'baseline';
if(!/^[a-z0-9-]{1,30}$/.test(label))throw Error('Invalid benchmark label');
const pauseMs=Number(process.argv[4]??850);
if(![600,850,1100].includes(pauseMs))throw Error('Expected calibrated pause of 600/850/1100ms');
const voicePath=join(tmpdir(),'vvs-spanish-pause-synthetic');
const scenarios=[
  {name:'appointment-date',clips:['A1','A2']},
  {name:'hours-follow-up',clips:['B1','B2']},
  {name:'services-follow-up',clips:['C1','C2']},
];
const url=new URL(env.LIVEKIT_URL!);
if(url.protocol!=='wss:'||!url.hostname.endsWith('.livekit.cloud'))
  throw Error('Unexpected isolated LiveKit endpoint');
const jwt=(identity:string,video:Record<string,unknown>)=>{
  const encode=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString('base64url');
  const now=Math.floor(Date.now()/1000);
  const header=encode({alg:'HS256',typ:'JWT'});
  const payload=encode({iss:env.LIVEKIT_API_KEY,sub:identity,iat:now-10,exp:now+150,video});
  const body=header+'.'+payload;
  return body+'.'+createHmac('sha256',env.LIVEKIT_API_SECRET!).update(body).digest('base64url');
};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function readPcm(name:string):Int16Array{
  const wav=readFileSync(join(voicePath,name+'.wav'));
  if(wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')
    throw Error('Invalid WAV '+name);
  let pos=12,format=false,data:Buffer|null=null;
  while(pos+8<=wav.length){
    const tag=wav.toString('ascii',pos,pos+4),sz=wav.readUInt32LE(pos+4);
    const body=pos+8;if(body+sz>wav.length)throw Error('Malformed WAV chunk');
    if(tag==='fmt '){
      if(wav.readUInt16LE(body)!==1||wav.readUInt16LE(body+2)!==1||
        wav.readUInt32LE(body+4)!==16000||wav.readUInt16LE(body+14)!==16)
        throw Error('Expected mono PCM16 16kHz '+name);
      format=true;
    }else if(tag==='data')data=wav.subarray(body,body+sz);
    pos=body+sz+(sz%2);
  }
  if(!format||!data||data.length%2!==0)throw Error('Missing PCM data '+name);
  const out=new Int16Array(data.length/2);
  for(let i=0;i<out.length;i++)out[i]=data.readInt16LE(i*2);
  return out;
}
const samples=new Map(['A1','A2','B1','B2','C1','C2'].map(k=>[k,readPcm(k)]));
const silence=new Int16Array(320);
async function feed(source:AudioSource,pcm:Int16Array){
  for(let i=0;i<pcm.length;i+=320){
    const slice=pcm.subarray(i,Math.min(i+320,pcm.length));
    await source.captureFrame(new AudioFrame(slice,16000,1,slice.length));
  }
}
async function gap(source:AudioSource,ms:number){
  for(let i=0;i<ms;i+=20)
    await source.captureFrame(new AudioFrame(silence,16000,1,320));
}
type RecordItem={name:string;pauseMs:number;joined:boolean;heardGreeting:boolean;
  endToSpeechMs:number|null;premature:boolean;assistantWords:number;
  userTranscripts:number;durationMs:number};
const results:RecordItem[]=[];
for(let n=0;n<rounds;n++){
 const scenario=scenarios[n%scenarios.length]!;
 const roomName='vvs-pause-'+randomBytes(6).toString('hex');
 const room=new Room();
 let joined=false,greetingAt:number|null=null;
 let lastGreetingSpeechAt:number|null=null;
 let responseAt:number|null=null,inputStarted=false;
 let userTranscripts=0;
 const agentWords:string[]=[];
 room.on(RoomEvent.ParticipantConnected,p=>{
   if(p.identity.startsWith('agent-'))joined=true;
 });
 room.registerTextStreamHandler('lk.transcription',async(reader,p)=>{
   try{
     const txt=await reader.readAll();
     if(p.identity.startsWith('agent-')&&inputStarted)agentWords.push(txt);
     else if(inputStarted)userTranscripts++;
   }catch{ /* Abort/disconnect is expected in isolated synthetic tests. */ }
 });
 room.on(RoomEvent.TrackSubscribed,(track,_pub,p)=>{
   if(track.kind!==TrackKind.KIND_AUDIO||!p.identity.startsWith('agent-'))return;
   const stream=new AudioStream(track,16000,1);
   void(async()=>{
     for await(const frame of stream){
       let audible=false;
       for(let i=0;i<frame.data.length;i+=8)
         if(Math.abs(frame.data[i]??0)>200){audible=true;break;}
       if(!audible)continue;
       const at=performance.now();
       if(greetingAt===null)greetingAt=at;
       if(!inputStarted)lastGreetingSpeechAt=at;
       else if(responseAt===null)responseAt=at;
     }
   })().catch(()=>{});
 });
 const begin=performance.now();
 let src:AudioSource|null=null;
 let track:LocalAudioTrack|null=null;
 try{
   await room.connect(env.LIVEKIT_URL!,jwt('synthetic-speech-'+n,{
     roomJoin:true,room:roomName,canSubscribe:true,canPublish:true,canPublishData:false,
   }),{autoSubscribe:true,dynacast:false});
   const control=jwt('benchmark-controller',{roomAdmin:true,room:roomName});
   const res=await fetch('https://'+url.hostname+'/twirp/livekit.AgentDispatchService/CreateDispatch',{
     method:'POST',headers:{Authorization:'Bearer '+control,'Content-Type':'application/json'},
     body:JSON.stringify({room:roomName,agent_name:'vvs-calendar-staging'}),
     signal:AbortSignal.timeout(12000),
   });
   if(!res.ok)throw Error('Agent dispatch HTTP '+res.status);
   const greetingDeadline=Date.now()+22000;
   while(greetingAt===null&&Date.now()<greetingDeadline)await sleep(150);
   if(greetingAt===null)throw Error('No agent greeting audio');
   // Wait until the greeting really ends, rather than using a guessed duration.
   const quietDeadline=Date.now()+24000;
   while((lastGreetingSpeechAt===null||performance.now()-lastGreetingSpeechAt<1700)&&
     Date.now()<quietDeadline)await sleep(100);
   if(lastGreetingSpeechAt===null||performance.now()-lastGreetingSpeechAt<1700)
     throw Error('Greeting did not become quiet; cannot measure next response');
   // Publish only after the agent has joined and initialized; this makes the
   // agent receive a new track-published notification instead of a stale track.
   src=new AudioSource(16000,1);
   track=LocalAudioTrack.createAudioTrack('synthetic-es-MX',src);
   const o=new TrackPublishOptions();o.source=TrackSource.SOURCE_MICROPHONE;
   await room.localParticipant!.publishTrack(track,o);
   await sleep(800);
   inputStarted=true;
   await feed(src,samples.get(scenario.clips[0]!)!);
   await gap(src,pauseMs);
   await feed(src,samples.get(scenario.clips[1]!)!);
   await src.waitForPlayout();
   const inputEnded=performance.now();
   const until=Date.now()+15500;
   while(responseAt===null&&Date.now()<until)await sleep(100);
   if(responseAt!==null)await sleep(1200);
   const delta=responseAt===null?null:Math.round(responseAt-inputEnded);
   const sample:RecordItem={name:scenario.name,pauseMs,joined,
     heardGreeting:greetingAt!==null,endToSpeechMs:delta,premature:delta!==null&&delta<0,
     assistantWords:agentWords.join(' ').trim().split(/\s+/).filter(Boolean).length,
     userTranscripts,durationMs:Math.round(performance.now()-begin)};
   results.push(sample);
   console.log('BENCH_SAMPLE='+JSON.stringify(sample));
 }catch(err){
   const e=err as Error;
   const sample:RecordItem={name:scenario.name,pauseMs,joined,
     heardGreeting:greetingAt!==null,endToSpeechMs:null,premature:false,
     assistantWords:0,userTranscripts,durationMs:Math.round(performance.now()-begin)};
   results.push(sample);
   console.log('BENCH_FAILURE='+JSON.stringify({sample,error:e.name,message:e.message.slice(0,130)}));
 }finally{
   try{await track?.close();}catch{ /* Synthetic track may already be closed. */ }
   try{await src?.close();}catch{ /* Audio source may already be closed. */ }
   try{await room.disconnect();}catch{ /* Disconnect can race with remote closure. */ }
   await sleep(250);
 }
}
const ok=results.map(x=>x.endToSpeechMs).filter((v):v is number=>v!==null&&v>=0).sort((a,b)=>a-b);
const q=(percent:number)=>ok.length?ok[Math.max(0,Math.ceil(percent*ok.length)-1)]:null;
const summary={
 label,sessions:rounds,validResponseSamples:ok.length,
 premature:results.filter(x=>x.premature).length,
 noResponse:results.filter(x=>x.endToSpeechMs===null).length,
 p50Ms:q(.5),p95Ms:q(.95),
 meanAgentWords:results.reduce((a,b)=>a+b.assistantWords,0)/results.length,
 samples:results,
};
const file=join(tmpdir(),'vvs-spanish-benchmark-'+label+'.json');
writeFileSync(file,JSON.stringify(summary,null,2));
console.log('BENCH_SUMMARY='+JSON.stringify(summary));
console.log('BENCH_FILE='+file);
await dispose();
process.exit(results.some(x=>!x.joined||x.endToSpeechMs===null)?1:0);
