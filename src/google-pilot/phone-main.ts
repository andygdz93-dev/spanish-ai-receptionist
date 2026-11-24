// Temporary, disarmed-by-default inbound phone test worker in the original project.
// It does not replace, restart, or mutate the original 'my-agent' worker.
import { ServerOptions, cli, defineAgent, inference, voice, Agent, tool } from '@livekit/agents';
import { ParticipantKind } from '@livekit/rtc-node';
import { EnhancerModel, audioEnhancement } from '@livekit/plugins-ai-coustics';
import { google } from 'googleapis';
import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { RECEPTIONIST_GREETING } from '../greeting.ts';
import { GooglePilot, googlePilotCalendar } from './pilot.ts';
import { PHONE_TEST_AGENT_NAME, PHONE_TEST_ENV_PATH, phoneTestArmed, readPhoneTestConfig } from './phone-config.ts';

if (process.argv.slice(2).some(a => /^--(?:url|api-key|api-secret|worker-token)(?:=|$)/.test(a)))
  throw new Error('Phone test forbids CLI LiveKit credential overrides');

const phoneSettings = parse(readFileSync(PHONE_TEST_ENV_PATH, 'utf8'));
const isolatedEnv = parse(readFileSync('.env.google-pilot.local', 'utf8'));
const originalEnv = parse(readFileSync('.env.local', 'utf8'));
const { pilot: config, expectedRuleId, expectedCalledNumber } =
  readPhoneTestConfig(phoneSettings, isolatedEnv, originalEnv);

const oauth = new google.auth.OAuth2(config.clientId, config.clientSecret);
oauth.setCredentials({ refresh_token: config.refreshToken });
const identity = await google.oauth2({ version: 'v2', auth: oauth }).userinfo.get();
if (identity.data.email?.toLowerCase() !== 'andygdz653@gmail.com')
  throw new Error('Unexpected Google OAuth identity');

process.env.LIVEKIT_URL = config.livekitUrl;
process.env.LIVEKIT_API_KEY = config.livekitKey;
process.env.LIVEKIT_API_SECRET = config.livekitSecret;
process.env.DENTAL_BOOKINGS_ENABLED = 'no';
process.env.HQ_TELEMETRY_PRODUCER_ENABLED = 'no';

export default defineAgent({
  entry: async (ctx) => {
    // This worker cannot handle browser clients or unreviewed telephone routes.
    await ctx.connect();
    const caller = await ctx.waitForParticipant();
    if (caller.kind !== ParticipantKind.SIP ||
        caller.attributes['sip.ruleID'] !== expectedRuleId ||
        caller.attributes['sip.trunkPhoneNumber'] !== expectedCalledNumber ||
        !phoneTestArmed()) {
      console.warn('PHONE_PILOT_REJECTED_UNVERIFIED_SIP_ROUTE');
      ctx.shutdown();
      return;
    }
    const pilot = new GooglePilot(config, googlePilotCalendar(config, { retainAfterCall: true }));
    const session = new voice.AgentSession({
      stt: new inference.STT({ model: 'assemblyai/universal-3-6-pro' }),
      tts: new inference.TTS({
        model: 'fishaudio/s2.1-pro',
        voice: originalEnv.DENTAL_TTS_VOICE_ID || 'd4bd2aebe8344d7288fb23728965da9c',
        language: 'es',
        modelOptions: { speed: 0.98, temperature: 0.75 },
      }),
      turnHandling: {
        turnDetection: new inference.TurnDetector(),
        preemptiveGeneration: { enabled: true },
      },
      expressive: true,
    });
    const agent = Agent.create({
      llm: new inference.LLM({ model: 'google/gemma-4-31b-it' }),
      tools: [
        tool({
          name: 'checkPilotAvailability',
          description: 'Consulta SOLO el horario predefinido de limpieza de prueba; nunca ofrece citas reales.',
          parameters: z.object({}),
          execute: async () => {
            if (!phoneTestArmed()) return JSON.stringify({ status: 'test_disarmed' });
            try {
              const status = await pilot.availability();
              return JSON.stringify({ status, date: config.date, time: config.time, testOnly: true });
            } catch {
              return JSON.stringify({ status: 'calendar_error', testOnly: true });
            }
          },
        }),
        tool({
          name: 'bookPilotAppointment',
          description: 'Reserva exclusivamente el evento técnico temporal tras confirmación verbal explícita.',
          parameters: z.object({ confirmed: z.boolean(), testPhraseSpoken: z.boolean() }),
          execute: async ({ confirmed, testPhraseSpoken }) => {
            if (!phoneTestArmed() || !confirmed || !testPhraseSpoken)
              return JSON.stringify({ status: 'not_authorized', testOnly: true });
            try {
              const status = await pilot.book(true);
              return JSON.stringify({
                status, testOnly: true, date: config.date, time: config.time,
                googleTestEvent: status === 'booked', realPatientBooking: false,
                willRemainInCalendarAfterCall: status === 'booked',
              });
            } catch {
              return JSON.stringify({ status: 'calendar_write_failed', testOnly: true });
            }
          },
        }),
      ],
      instructions: [
        'Eres la asistente virtual de VVZ Smilez en una llamada TELEFÓNICA DE PRUEBA TÉCNICA.',
        'Saluda exactamente como indica la sesión y no inventes datos del consultorio.',
        'Aclara que NO es una cita de paciente real, sino una prueba técnica.',
        'El evento de prueba permanece en Google Calendar después de colgar.',
        'La persona debe decir expresamente «prueba técnica de calendario» antes de reservar.',
        'Si no dice esa frase de prueba, NO llames bookPilotAppointment.',
        'Solo cuando confirma explícitamente el evento técnico permanente y dice la frase,',
        'llama bookPilotAppointment con confirmed=true y testPhraseSpoken=true.',
        'Consulta checkPilotAvailability antes de ofrecer el único horario.',
        'La única opción de limpieza de prueba es el ' + config.date + ' a las ' +
          config.time + ' (hora de Tijuana). No ofrezcas otros horarios o servicios.',
        'Nunca preguntes por nombres, teléfonos, correos, seguros o datos de salud.',
        'Nunca almacenes datos de pacientes ni envíes invitaciones o notificaciones.',
        'Si la herramienta devuelve booked, confirma SOLO el evento de prueba en Google Calendar.',
        'Explícale que seguirá guardado en Google Calendar después de colgar.',
        'Si devuelve unavailable, already_used, test_disarmed, not_authorized,',
        'needs_reconciliation o error, explica que no se reservó ninguna cita real.',
        'Si la persona busca atención clínica real, remítela a la clínica.',
        'Habla español mexicano natural, breve, una pregunta a la vez.',
      ].join('\n'),
    });

    // This controlled phone test intentionally RETAINS its synthetic Calendar event.
    // No shutdown cleanup: the one-use ledger stays locked after booking.
    // A separate manual cleanup command exists, but is never run on hangup.
    await session.start({
      agent, room: ctx.room,
      inputOptions: { noiseCancellation: audioEnhancement({ model: EnhancerModel.QuailVfS }) },
    });
    session.say(RECEPTIONIST_GREETING);
  },
});

cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: PHONE_TEST_AGENT_NAME,
  host: '127.0.0.1',
  port: config.healthPort,
}));
