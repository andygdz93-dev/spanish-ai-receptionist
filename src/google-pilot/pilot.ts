import { randomBytes } from 'node:crypto';
import { existsSync, openSync, closeSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { isAbsolute, dirname, relative, resolve } from 'node:path';
import { DateTime } from 'luxon';
// Google SDK is imported only when a Calendar operation is requested;
// eager import in each LiveKit job child delayed voice initialization.

export const PILOT_CALENDAR_ID =
  '473e51b5329a173e885c3fe8db7cf83305bda22f5fa09a2441cdda034a823dc4@group.calendar.google.com';
export const PILOT_AGENT_NAME = 'vvs-google-pilot';

export type PilotConfig = {
  calendarId: string; clientId: string; clientSecret: string; refreshToken: string;
  start: string; end: string; date: string; time: string; statePath: string;
  livekitUrl: string; livekitKey: string; livekitSecret: string; healthPort: number;
};
export type PilotState = {
  version: 1; eventId: string; start: string; end: string;
  status: 'attempted'|'created'|'cleaned'; createdAt: string; updatedAt: string;
  writeVerifiedAt?: string; cleanupVerifiedAt?: string;
};
export type PilotCalendar = {
  freeBusy: (start:string,end:string,calendarId:string) => Promise<Array<{start:string;end:string}>>;
  insert: (id:string,start:string,end:string,calendarId:string) => Promise<void>;
  get: (id:string,calendarId:string) => Promise<{id:string;status?:string;start?:string;end?:string}|null>;
  delete: (id:string,calendarId:string) => Promise<void>;
};
export function readPilotConfig(
  env:NodeJS.ProcessEnv,
  existing:NodeJS.ProcessEnv,
  root=process.cwd(),
  now=DateTime.now(),
  cleanupOnly=false,
):PilotConfig {
  const expected:Record<string,string>={
    VVS_RUNTIME_PROFILE:'google-pilot',VVS_GOOGLE_PILOT_APPROVED:'yes',
    VVS_PILOT_PROJECT_REVIEWED:'yes',
    DENTAL_DEMO_MODE:'no',DENTAL_BOOKINGS_ENABLED:'no',
    HQ_TELEMETRY_PRODUCER_ENABLED:'no',
  };
  for(const [key,value] of Object.entries(expected)){
    if(env[key]!==value)throw new Error('Pilot blocked: missing reviewed flag '+key);
  }
  const phoneRoute=env.VVS_PILOT_CALL_ROUTE_VERIFIED==='yes';
  const browserRoute=env.VVS_PILOT_BROWSER_ROUTE_VERIFIED==='yes';
  if(phoneRoute===browserRoute ||
     !['yes','no'].includes(env.VVS_PILOT_CALL_ROUTE_VERIFIED??'') ||
     (env.VVS_PILOT_BROWSER_ROUTE_VERIFIED!==undefined &&
      !['yes','no'].includes(env.VVS_PILOT_BROWSER_ROUTE_VERIFIED)))
    throw new Error('Pilot requires exactly one verified phone or browser-only route');
  if(env.DENTAL_CALENDAR_ID!==PILOT_CALENDAR_ID)
    throw new Error('Pilot must target the dedicated VVS Smilez calendar');
  for(const key of ['LIVEKIT_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET',
    'GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN']){
    if(!env[key]?.trim())throw new Error('Pilot missing credential: '+key);
  }
  const url=env.LIVEKIT_URL!;
  if(url!==env.VVS_PILOT_LIVEKIT_URL || !url.startsWith('wss://'))
    throw new Error('Pilot URL is not the reviewed isolated LiveKit endpoint');
  if(url===existing.LIVEKIT_URL || env.LIVEKIT_API_KEY===existing.LIVEKIT_API_KEY)
    throw new Error('Pilot cannot use the existing phone agent LiveKit project');
  const port=Number(env.VVS_PILOT_HEALTH_PORT);
  if(!Number.isInteger(port)||port<1024||port>65535||[8081,8787,18788,18081].includes(port))
    throw new Error('Pilot requires a distinct local health port');
  const date=env.VVS_PILOT_TEST_DATE??'',time=env.VVS_PILOT_TEST_TIME??'';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new Error('Pilot requires an exact test date and time');
  const slot=DateTime.fromISO(date+'T'+time,{zone:'America/Tijuana'});
  if(!slot.isValid||slot.toISODate()!==date||slot.toFormat('HH:mm')!==time||
     slot.weekday>5||slot.hour<9||slot.minute!==0||
     slot.plus({minutes:75})>slot.set({hour:17,minute:0,second:0,millisecond:0})||
     (!cleanupOnly && (slot<now.setZone('America/Tijuana').plus({minutes:60})||
     slot>now.setZone('America/Tijuana').plus({days:14}))))
    throw new Error('Pilot slot outside approved weekday 9-17, 14-day test window');
  const statePath=env.VVS_PILOT_STATE_PATH??'';
  if(!isAbsolute(statePath)||!statePath.toLowerCase().endsWith('.json'))
    throw new Error('Pilot state requires an absolute .json path');
  const rel=relative(resolve(root),resolve(statePath));
  if(!rel || (rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../')&&!isAbsolute(rel)))
    throw new Error('Pilot state must be stored outside source repository');
  if(!existsSync(dirname(statePath)))
    throw new Error('Pilot state parent folder must already exist');
  return {
    calendarId:PILOT_CALENDAR_ID,clientId:env.GOOGLE_CLIENT_ID!,
    clientSecret:env.GOOGLE_CLIENT_SECRET!,refreshToken:env.GOOGLE_REFRESH_TOKEN!,
    start:slot.toUTC().toISO()!,end:slot.plus({minutes:75}).toUTC().toISO()!,
    date,time,statePath:resolve(statePath),livekitUrl:url,
    livekitKey:env.LIVEKIT_API_KEY!,livekitSecret:env.LIVEKIT_API_SECRET!,
    healthPort:port,
  };
}
export function pilotTestEventLabel(retainAfterCall=false):string {
  return retainAfterCall
    ? 'VVS Smilez — CITA TÉCNICA DE PRUEBA (conservar)'
    : 'VVS Smilez — PRUEBA TÉCNICA (eliminar)';
}
async function createCalendarClient(config:PilotConfig){
  const {google}=await import('googleapis');
  const auth=new google.auth.OAuth2(config.clientId,config.clientSecret);
  auth.setCredentials({refresh_token:config.refreshToken});
  return google.calendar({version:'v3',auth});
}
export function googlePilotCalendar(
  config:PilotConfig,
  options:{retainAfterCall?:boolean}={},
):PilotCalendar {
  let clientPromise:ReturnType<typeof createCalendarClient>|null=null;
  const api=()=>clientPromise??=createCalendarClient(config);
  return {
    async freeBusy(start,end,calendarId){
      const client=await api();
      const r=await client.freebusy.query({requestBody:{
        timeMin:start,timeMax:end,items:[{id:calendarId}],
      }});
      const entry=r.data.calendars?.[calendarId];
      if(!entry||entry.errors?.length)throw new Error('Google availability unavailable');
      return (entry.busy??[]).map(b=>{
        if(!b.start||!b.end)throw new Error('Malformed busy interval');
        return {start:b.start,end:b.end};
      });
    },
    async insert(id,start,end,calendarId){
      const client=await api();
      const r=await client.events.insert({
        calendarId,sendUpdates:'none',requestBody:{
          id,summary:pilotTestEventLabel(options.retainAfterCall===true),
          description:options.retainAfterCall
            ? 'Evento técnico de prueba que permanece tras colgar. Sin paciente real ni notificaciones.'
            : 'Evento de prueba automatizada. Sin paciente real, sin teléfono, sin notificaciones.',
          start:{dateTime:start,timeZone:'America/Tijuana'},
          end:{dateTime:end,timeZone:'America/Tijuana'},
          visibility:'private',transparency:'opaque',
          extendedProperties:{private:{vvs_pilot:'one_call_synthetic'}},
        },
      });
      if(r.data.id!==id||r.data.status==='cancelled')
        throw new Error('Google did not acknowledge expected test event');
    },
    async get(id,calendarId){
      const client=await api();
      try{
        const r=await client.events.get({calendarId,eventId:id});
        return {id:r.data.id??'',
          ...(r.data.status ? {status:r.data.status} : {}),
          ...(r.data.start?.dateTime ? {start:r.data.start.dateTime} : {}),
          ...(r.data.end?.dateTime ? {end:r.data.end.dateTime} : {})};
      }catch(error){
        if((error as {response?:{status?:number}}).response?.status===404)return null;
        throw error;
      }
    },
    async delete(id,calendarId){
      const client=await api();
      try{await client.events.delete({calendarId,eventId:id,sendUpdates:'none'});}
      catch(error){
        if((error as {response?:{status?:number}}).response?.status!==404)throw error;
      }
    },
  };
}
export function readPilotState(path:string):PilotState|null {
  if(!existsSync(path))return null;
  const state=JSON.parse(readFileSync(path,'utf8')) as PilotState;
  if(state.version!==1||!/^vvstest[0-9a-f]{24}$/.test(state.eventId)||
      !['attempted','created','cleaned'].includes(state.status))
    throw new Error('Pilot state invalid; manual operator review required');
  return state;
}
function persist(path:string,state:PilotState){
  const temporary=path+'.tmp-'+process.pid+'-'+randomBytes(3).toString('hex');
  writeFileSync(temporary,JSON.stringify(state,null,2)+'\n',{flag:'wx',mode:0o600});
  renameSync(temporary,path);
}
export class GooglePilot {
  readonly config:PilotConfig;
  readonly cal:PilotCalendar;
  constructor(config:PilotConfig,cal:PilotCalendar){this.config=config;this.cal=cal;}
  async availability():Promise<'available'|'busy'|'already_used'> {
    if(readPilotState(this.config.statePath))return 'already_used';
    const occupied=await this.cal.freeBusy(this.config.start,this.config.end,this.config.calendarId);
    return occupied.some(b=>Date.parse(b.start)<Date.parse(this.config.end)&&
      Date.parse(b.end)>Date.parse(this.config.start))?'busy':'available';
  }
  async book(confirmed:boolean):Promise<'booked'|'already_used'|'unavailable'|'confirmation_required'|'needs_reconciliation'> {
    if(!confirmed)return 'confirmation_required';
    if(readPilotState(this.config.statePath))return 'already_used';
    if(await this.availability()!=='available')return 'unavailable';
    const id='vvstest'+randomBytes(12).toString('hex');
    const state:PilotState={version:1,eventId:id,start:this.config.start,end:this.config.end,
      status:'attempted',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    let fd:number;
    try{fd=openSync(this.config.statePath,'wx',0o600);}
    catch(error){
      if((error as NodeJS.ErrnoException).code==='EEXIST')return 'already_used';
      throw error;
    }
    try{writeFileSync(fd,JSON.stringify(state,null,2)+'\n');}
    finally{closeSync(fd);}
    try{
      await this.cal.insert(id,state.start,state.end,this.config.calendarId);
      const event=await this.cal.get(id,this.config.calendarId);
      if(!event||event.status==='cancelled'||event.id!==id||
        Date.parse(event.start??'')!==Date.parse(state.start)||
        Date.parse(event.end??'')!==Date.parse(state.end))
        return 'needs_reconciliation';
      state.status='created';state.updatedAt=new Date().toISOString();
      state.writeVerifiedAt=state.updatedAt;
      persist(this.config.statePath,state);
      return 'booked';
    }catch{return 'needs_reconciliation';}
  }
  async cleanup():Promise<{status:'not_attempted'|'cleaned'|'needs_review';slotBusy:boolean|null}> {
    const state=readPilotState(this.config.statePath);
    if(!state)return {status:'not_attempted',slotBusy:null};
    try{
      const event=await this.cal.get(state.eventId,this.config.calendarId);
      if(event && event.status!=='cancelled'){
        await this.cal.delete(state.eventId,this.config.calendarId);
      }
      const after=await this.cal.get(state.eventId,this.config.calendarId);
      if(after && after.status!=='cancelled')
        return {status:'needs_review',slotBusy:null};
      const busy=await this.cal.freeBusy(state.start,state.end,this.config.calendarId);
      const slotBusy=busy.some(b=>Date.parse(b.start)<Date.parse(state.end)&&
        Date.parse(b.end)>Date.parse(state.start));
      state.status='cleaned';state.updatedAt=new Date().toISOString();
      state.cleanupVerifiedAt=state.updatedAt;
      persist(this.config.statePath,state);
      return {status:'cleaned',slotBusy};
    }catch{return {status:'needs_review',slotBusy:null};}
  }
}
