// VVS Smilez: browser-only, repeatable synthetic Calendar staging agent.
// Never use for live telephony, real patient scheduling, or personal information.
import { ServerOptions, cli, defineAgent, inference, voice, Agent, tool } from '@livekit/agents';
import { ParticipantKind } from '@livekit/rtc-node';
import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { STAGING_GREETING, STAGING_RESPONSE_RULES, normalizeStagingSlot } from './staging-dialogue.ts';
import { DateTime } from 'luxon';
import { StagingCalendarRpc } from './staging-calendar-rpc.ts';

if (process.argv.slice(2).some(a => /^--(?:url|api-key|api-secret|worker-token)(?:=|$)/.test(a)))
  throw new Error('Staging forbids CLI credential overrides');
const isolated = parse(readFileSync('.env.google-pilot.local','utf8'));
const original = parse(readFileSync('.env.local','utf8'));
const staging = parse(readFileSync('.env.google-staging.local','utf8'));
// Fail closed before registering this browser-only worker.
if (staging.VVS_STAGING_APPROVED!=='yes'||
    staging.VVS_STAGING_BROWSER_ONLY!=='yes'||
    !['yes','no'].includes(staging.VVS_STAGING_ALLOW_WRITES??''))
  throw new Error('Unapproved staging browser/write profile');
if (isolated.VVS_PILOT_CALL_ROUTE_VERIFIED!=='no'||
    isolated.VVS_PILOT_BROWSER_ROUTE_VERIFIED!=='yes')
  throw new Error('Staging cannot attach to a telephone SIP route');
const port = Number(staging.VVS_STAGING_HEALTH_PORT);
if (port !== 18084) throw new Error('Staging worker requires independent port 18084');
for (const [key,value] of Object.entries(isolated)) process.env[key] = value;
process.env.LIVEKIT_URL = isolated.LIVEKIT_URL;
process.env.LIVEKIT_API_KEY = isolated.LIVEKIT_API_KEY;
process.env.LIVEKIT_API_SECRET = isolated.LIVEKIT_API_SECRET;

export default defineAgent({
  entry: async ctx => {
    const startedAt = Date.now();
    await ctx.connect();
    console.log('VVS_STAGING_ROOM_CONNECTED_MS',Date.now()-startedAt);
    const participant = await ctx.waitForParticipant();
    console.log('VVS_STAGING_PARTICIPANT_CONNECTED_MS',Date.now()-startedAt);
    if (participant.kind === ParticipantKind.SIP) {
      console.warn('STAGING_REJECTED_SIP_PARTICIPANT');
      ctx.shutdown();
      return;
    }
    // Start the isolated Calendar thread without blocking the audio event loop.
    const calendarRpc=new StagingCalendarRpc();
    ctx.addShutdownCallback(async()=>{await calendarRpc.close();});
    let bookedInThisSession = false;
    let lastAvailableSlot:{date:string;time:string}|null=null;
    const session = new voice.AgentSession({
      stt: new inference.STT({model:'assemblyai/universal-3-6-pro'}),
      tts: new inference.TTS({
        model:'fishaudio/s2.1-pro',
        voice:original.DENTAL_TTS_VOICE_ID || 'd4bd2aebe8344d7288fb23728965da9c',
        language:'es',modelOptions:{speed:0.98,temperature:0.75},
      }),
      turnHandling:{
        turnDetection:new inference.TurnDetector(),
        // Hold brief pauses between a day, month, and time; adapt to actual pacing.
        endpointing:{mode:'dynamic',minDelay:850,maxDelay:2200,alpha:0.8},
        // Do not begin speculative responses to still-changing user transcripts.
        preemptiveGeneration:{enabled:false},
      },
      // No expressive markup or speculative generation until latency/error diagnostics pass.
      expressive:false,
    });
    session.on(voice.AgentSessionEventTypes.Error, e => {
      console.error('VVS_STAGING_MODEL_ERROR', {
        recoverable:e.error.recoverable,
      });
    });
    // These are server-side turn metrics, NOT proof of client-audible playback.
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, e => {
      if(!('role' in e.item)||e.item.role!=='assistant')return;
      const m=e.item.metrics;
      if(!m)return;
      if(m.e2eLatency!==undefined)
        console.log('VVS_STAGING_TURN_E2E_MS',Math.round(m.e2eLatency*1000));
      if(m.ttsNodeTtfb!==undefined)
        console.log('VVS_STAGING_TTS_FIRST_BYTE_MS',Math.round(m.ttsNodeTtfb*1000));
    });
    const agent = Agent.create({
      llm:new inference.LLM({model:'openai/gpt-4.1-mini'}),
      tools:[
        tool({
          name:'checkStagingAvailability',
          description:'Consulta fecha y hora exactas en Google Calendar de pruebas; no agenda citas reales.',
          parameters:z.object({
            date:z.string().describe('Fecha YYYY-MM-DD o frase natural: 25 de noviembre, el 25, mañana'),
            time:z.string().describe('Hora HH:mm o frase natural: 11 de la mañana, a las once, 2 de la tarde'),
          }),
          execute:async({date,time})=>{
            try {
              const slot=normalizeStagingSlot(date,time);
              if(slot.status!=='ok'){
                lastAvailableSlot=null;
                return JSON.stringify({status:slot.status,reason:slot.reason,testOnly:true});
              }
              const outcome=await calendarRpc.request('availability',slot.date,slot.time);
              lastAvailableSlot=outcome.status==='available'?{date:slot.date,time:slot.time}:null;
              return JSON.stringify({...outcome,date:slot.date,time:slot.time,
                confirmationRequired:outcome.status==='available',
                currentDateInTijuana:DateTime.now().setZone('America/Tijuana').toISODate(),
                ...(outcome.status==='invalid_slot'?{nextStep:'Solicite corregir fecha u hora; no invente disponibilidad'}:{})});
            }catch(error){
              console.warn('STAGING_AVAILABILITY_REJECTED', (error as Error).name);
              return JSON.stringify({status:'invalid_or_unavailable',date,time,testOnly:true});
            }
          },
        }),
        tool({
          name:'bookStagingAppointment',
          description:'Escribe un evento sintético de prueba persistente SOLO tras consentimiento explícito. Sin datos reales.',
          parameters:z.object({
            date:z.string().describe('Fecha YYYY-MM-DD o fecha pronunciada en español'),
            time:z.string().describe('Hora HH:mm o frase natural como 11 de la mañana'),
            confirmed:z.boolean().describe('Usuario confirmó explícitamente el evento técnico'),
          }),
          execute:async({date,time,confirmed})=>{
            if(bookedInThisSession)
              return JSON.stringify({status:'session_limit',testOnly:true,realPatientBooking:false});
            try {
              const slot=normalizeStagingSlot(date,time);
              if(slot.status!=='ok')
                return JSON.stringify({status:slot.status,reason:slot.reason,testOnly:true});
              if(!confirmed)
                return JSON.stringify({status:'confirmation_required',testOnly:true});
              if(!lastAvailableSlot||lastAvailableSlot.date!==slot.date||
                  lastAvailableSlot.time!==slot.time)
                return JSON.stringify({status:'check_availability_first',testOnly:true});
              const result=await calendarRpc.request('book',slot.date,slot.time,true);
              if(result.status==='booked'){
                bookedInThisSession=true;
                lastAvailableSlot=null;
              }
              console.log('VVS_STAGING_BOOKING_RESULT',result.status);
              return JSON.stringify(result);
            }catch(error){
              console.warn('STAGING_BOOKING_REJECTED', (error as Error).name);
              return JSON.stringify({status:'booking_error',testOnly:true,realPatientBooking:false});
            }
          },
        }),
      ],
      instructions:[
        'Eres la asistente virtual del consultorio de la dentista Florencia, en una SESIÓN SINTÉTICA DE PRUEBA en navegador.',
        'Tu saludo ya fue pronunciado. Identifica el consultorio como dentista Florencia, nunca VVZ Smiles.',
        'No confirmes citas clínicas reales ni solicites nombre, teléfono, correo, seguro o datos médicos.',
        'La fecha actual en Tijuana es '+DateTime.now().setZone('America/Tijuana').toISODate()+'.',
        'Solo puedes ofrecer horas en punto entre 09:00 y 15:00, de lunes a viernes, hora de Tijuana.',
        'El usuario puede decir la fecha y hora de forma natural o en turnos separados.',
        'Pasa la fecha/hora proporcionadas a checkStagingAvailability sin pedir que las reformule en formato ISO.',
        'La herramienta normaliza 11 de la mañana, 2 de la tarde, y días como el 25 en el mes actual.',
        'Si availability=available, pide confirmación verbal UNA sola vez, antes de llamar bookStagingAppointment.',
        'Solo UNA reserva por sesión; si ya reservaste, para otra prueba se necesita otra sesión.',
        'Nunca digas que guardaste una cita salvo cuando bookStagingAppointment responde status=booked.',
        'Si hay error o fecha ambigua, pregunta SOLO por el dato faltante, no inventes un año.',
        'No ofrezcas SMS, notificaciones, consultas reales ni reservas no verificadas.',
        ...STAGING_RESPONSE_RULES,
      ].join('\n'),
    });
    await session.start({agent,room:ctx.room});
    console.log('VVS_STAGING_VOICE_STARTUP_MS',Date.now()-startedAt);
    session.say(STAGING_GREETING);
    console.log('VVS_STAGING_GREETING_QUEUED_MS',Date.now()-startedAt);
    // Deliberately NO shutdown cleanup. Persistently saved test events remain.
  },
});

cli.runApp(new ServerOptions({
  agent:fileURLToPath(import.meta.url),
  agentName:'vvs-calendar-staging',
  // This Windows staging host cannot reliably prewarm 4 heavy job children.
  // Keep one idle job ready and allow more startup time under transient CPU load.
  numIdleProcesses:1,
  initializeProcessTimeout:30000,
  host:'127.0.0.1',
  port,
}));
