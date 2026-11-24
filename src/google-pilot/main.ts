// One-call Google Calendar pilot. Intentionally separate from the normal receptionist.
import { ServerOptions, cli, defineAgent, inference, voice, Agent, tool } from '@livekit/agents';
import { EnhancerModel, audioEnhancement } from '@livekit/plugins-ai-coustics';
import { google } from 'googleapis';
import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { RECEPTIONIST_GREETING } from '../greeting.ts';
import { GooglePilot, googlePilotCalendar, readPilotConfig, PILOT_AGENT_NAME } from './pilot.ts';

if(process.argv.slice(2).some(a=>/^--(?:url|api-key|api-secret|worker-token)(?:=|$)/.test(a)))
  throw new Error('Pilot forbids CLI LiveKit credential overrides');
const pilotEnv=parse(readFileSync('.env.google-pilot.local','utf8'));
const productionEnv=parse(readFileSync('.env.local','utf8'));
const config=readPilotConfig(pilotEnv,productionEnv);
const oauth=new google.auth.OAuth2(config.clientId,config.clientSecret);
oauth.setCredentials({refresh_token:config.refreshToken});
const identity=await google.oauth2({version:'v2',auth:oauth}).userinfo.get();
if(identity.data.email?.toLowerCase()!=='andygdz653@gmail.com')
  throw new Error('Pilot OAuth authorization is for an unexpected account');
for(const [key,value] of Object.entries(pilotEnv))process.env[key]=value;
process.env.LIVEKIT_URL=config.livekitUrl;
process.env.LIVEKIT_API_KEY=config.livekitKey;
process.env.LIVEKIT_API_SECRET=config.livekitSecret;

export default defineAgent({
  entry:async(ctx)=>{
    const pilot=new GooglePilot(config,googlePilotCalendar(config));
    let eventAttemptedByThisCall=false;
    const session=new voice.AgentSession({
      stt:new inference.STT({model:'assemblyai/universal-3-6-pro'}),
      tts:new inference.TTS({
        model:'fishaudio/s2.1-pro',
        voice:process.env.DENTAL_TTS_VOICE_ID||'d4bd2aebe8344d7288fb23728965da9c',
        language:'es',modelOptions:{speed:0.98,temperature:0.75},
      }),
      turnHandling:{turnDetection:new inference.TurnDetector(),preemptiveGeneration:{enabled:true}},
      expressive:true,
    });
    const patientAgent=Agent.create({
      llm:new inference.LLM({model:'google/gemma-4-31b-it'}),
      tools:[
        tool({
          name:'checkPilotAvailability',
          description:'Comprueba exclusivamente el único horario de PRUEBA configurado. No examines ni ofrezcas otras citas.',
          parameters:z.object({}),
          execute:async()=>{
            try{
              const status=await pilot.availability();
              return JSON.stringify({status,date:config.date,time:config.time,
                type:'one_time_google_test',realPatientBooking:false});
            }catch{return JSON.stringify({status:'calendar_error',realPatientBooking:false});}
          },
        }),
        tool({
          name:'bookPilotAppointment',
          description:'Escribe SOLO el evento técnico de prueba después de que la persona confirme expresamente la prueba. Nunca es una cita para un paciente real.',
          parameters:z.object({confirmed:z.boolean()}),
          execute:async({confirmed})=>{
            try{
              const status=await pilot.book(confirmed);
              if(status==='booked'||status==='needs_reconciliation')eventAttemptedByThisCall=true;
              return JSON.stringify({status,date:config.date,time:config.time,
                googleTestEvent:status==='booked',realPatientBooking:false,
                willRemoveAfterCall:status==='booked'});
            }catch{return JSON.stringify({status:'internal_error',realPatientBooking:false});}
          },
        }),
      ],
      instructions:[
        'Eres la asistente virtual de VVZ Smilez en una llamada de PRUEBA TÉCNICA.',
        'Comienza con el saludo de sesión exactamente, sin repetirlo. Antes de reservar informa',
        'que esta llamada no genera una cita real para pacientes y que el evento de prueba será',
        'eliminado después de colgar. Nunca solicites ni repitas nombre completo, teléfono,',
        'email, datos de salud ni información sensible; no guardes información personal.',
        'Solo existe UNA cita de prueba de limpieza dental el '+config.date+', a las',
        config.time+' (hora de Tijuana). No ofrezcas otras fechas ni servicios.',
        'Consulta checkPilotAvailability antes de ofrecer el horario.',
        'Si está libre, pregunta: ¿Confirma que desea crear únicamente un evento de prueba temporal en Google Calendar?',
        'Solamente después de respuesta afirmativa explícita llama bookPilotAppointment con confirmed=true.',
        'Si rechaza, confirmed=false o no llames la herramienta.',
        'Si status=booked, di que el evento técnico fue guardado y se eliminará al terminar la llamada.',
        'NO digas que existe una cita real ni que se avisó a la clínica.',
        'Si la reserva falla o el horario está ocupado, reconoce el fallo sin inventar resultados.',
        'Si quieren una cita real, pide hablar con la clínica por sus canales oficiales.',
        'Nunca prometas transferencias, SMS, notificaciones ni citas reales.',
        'Habla español mexicano claro, una pregunta a la vez. No diagnostiques.',
      ].join('\n'),
    });
    ctx.addShutdownCallback(async()=>{
      if(!eventAttemptedByThisCall)return;
      const result=await pilot.cleanup();
      console.log('GOOGLE_PILOT_CLEANUP',result.status,
        'slotBusy=',result.slotBusy===null?'unknown':result.slotBusy);
    });
    await session.start({agent:patientAgent,room:ctx.room,inputOptions:{
      noiseCancellation:audioEnhancement({model:EnhancerModel.QuailVfS}),
    }});
    await ctx.connect();
    session.say(RECEPTIONIST_GREETING);
  },
});
cli.runApp(new ServerOptions({
  agent:fileURLToPath(import.meta.url),
  agentName:PILOT_AGENT_NAME,
  host:'127.0.0.1',port:config.healthPort,
}));
