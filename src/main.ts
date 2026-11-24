import { ServerOptions, cli, defineAgent, inference, voice } from '@livekit/agents';
import { EnhancerModel, audioEnhancement } from '@livekit/plugins-ai-coustics';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createAgent } from './agent.ts';
import { attachOperationalLifecycle } from './operational-lifecycle.ts';
import { validateStagingProfile } from './staging-profile.ts';
import { readStagingWorkerServerConfig } from './staging-health-target.ts';
import { RECEPTIONIST_GREETING } from './greeting.ts';

// Load environment variables from a local file.
// Make sure to set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET
// when running locally or self-hosting your agent server.
dotenv.config({ path: process.env.VVS_RUNTIME_PROFILE === 'staging' ? '.env.staging.local' : '.env.local' });
validateStagingProfile(process.env);
const stagingWorkerListener = readStagingWorkerServerConfig(process.env);

export default defineAgent({
  entry: async (ctx) => {
    // Set up a voice AI pipeline using AssemblyAI, Fish Audio, and the LiveKit turn detector
    const session = new voice.AgentSession({
      // Speech-to-text (STT) is your agent's ears, turning the user's speech into text that the LLM can understand
      // See all available models at https://docs.livekit.io/agents/models/stt/
      stt: new inference.STT({
        model: 'assemblyai/universal-3-6-pro',
      }),

      // Keyterms bias the STT toward distinctive words it would otherwise misspell.
      // List your own names, brands, and jargon in `keyterms`. Detection additionally
      // extracts terms from the live conversation, such as a caller's name, and applies
      // them once the transcript corroborates the spelling.
      // See more at https://docs.livekit.io/agents/models/stt/keyterms/
      keytermsOptions: {
        keyterms: ['VVS Smilez', 'brackets', 'ortodoncia', 'blanqueamiento', 'endodoncia', 'implantes dentales'],
        keytermDetection: { enabled: true },
      },

      // Text-to-speech (TTS) is your agent's voice, turning the LLM's text into speech that the user can hear
      // See all available models as well as voice selections at https://docs.livekit.io/agents/models/tts/
      tts: new inference.TTS({
        model: 'fishaudio/s2.1-pro',
        voice: process.env.DENTAL_TTS_VOICE_ID || 'd4bd2aebe8344d7288fb23728965da9c',
        language: 'es',
        // Fish Audio prosody: conversational pace with modest variation.
        modelOptions: { speed: 0.98, temperature: 0.75 },
      }),

      turnHandling: {
        // Turn detection determines when the user is speaking and when the agent should respond.
        // The LiveKit audio turn detector is a multimodal model that encodes the user's audio
        // directly to predict end of turn. It's built into the SDK (no extra plugin) and
        // AgentSession supplies the required VAD automatically.
        // See more at https://docs.livekit.io/agents/logic/turns/turn-detector/
        turnDetection: new inference.TurnDetector(),
        // Adaptive interruptions use the turn detector to tell a real interruption from a
        // backchannel like "mhm" or "right", so the agent keeps talking through the latter.
        // This model is on by default on LiveKit Cloud and in dev mode. To use the model elsewhere,
        // uncomment the `interruption` line. Self-hosted usage past the monthly allowance is billed.
        // See https://docs.livekit.io/deploy/admin/quotas-and-limits/#adaptive-interruption-handling for more information.
        // interruption: { mode: 'adaptive' },
        // Allow the LLM to generate a response while waiting for the end of turn
        preemptiveGeneration: { enabled: true },
      },

      // Expressive mode injects the TTS provider's markup guide into the LLM prompt, so the model
      // emits inline delivery tags (emotion, pacing, non-verbal sounds) that the TTS renders and
      // the transcript never shows. Requires a TTS model that supports markup, such as the Fish
      // Audio model above.
      expressive: true,
    });

    // Start the session, which initializes the voice pipeline and warms up the models
    await session.start({
      agent: createAgent(),
      room: ctx.room,
      inputOptions: {
        // ai-coustics QUAIL audio enhancement for noise cancellation
        // Works for both WebRTC and telephony (SIP) participants
        noiseCancellation: audioEnhancement({ model: EnhancerModel.QuailVfS }),
      },
    });

    // // Add a virtual avatar to the session, if desired
    // // For other providers, see https://docs.livekit.io/agents/models/avatar/
    // const avatar = new anam.AvatarSession({
    //   personaConfig: {
    //     name: '...',
    //     avatarId: '...', // See https://docs.livekit.io/agents/models/avatar/plugins/anam
    //   },
    // });
    // // Start the avatar and wait for it to join
    // await avatar.start(session, ctx.room);

    // Join the room and connect to the user
    await ctx.connect();

    // Opt-in, best-effort operational receipts; persisted locally before delivery.
    // Never prevent a working voice session because observability is unavailable.
    let telemetry: ReturnType<typeof attachOperationalLifecycle> = null;
    try { telemetry = attachOperationalLifecycle(ctx); }
    catch { console.warn('Operational telemetry unavailable; voice session continues'); }
    // Non-recoverable provider failures are operational failures, not patient detail.
    // Recoverable model errors do not mark a running session failed.
    if (telemetry) {
      session.on(voice.AgentSessionEventTypes.Error, (event) => {
        if (!event.error.recoverable) telemetry?.fail();
      });
    }

    // Speak the precise opening line via TTS instead of asking the LLM to paraphrase it.
    try { session.say(RECEPTIONIST_GREETING); }
    catch (error) { telemetry?.fail(); throw error; }
  },
});

// Run the agent server
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'my-agent',
    ...(stagingWorkerListener ?? {}),
  }),
);
