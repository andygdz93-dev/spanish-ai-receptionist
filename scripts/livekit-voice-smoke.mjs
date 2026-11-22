import { inference, initializeLogger, llm, stt as speech } from '@livekit/agents';
import dotenv from 'dotenv';
import fs from 'node:fs';

initializeLogger({ pretty: false, level: 'error' });
dotenv.config({ path: '.env.local', quiet: true });
if (!['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].every((k) => process.env[k]))
  throw new Error('Missing credentials');
if (process.env.LIVEKIT_TEST_SOFT_BUDGET_ACKNOWLEDGED !== 'yes')
  throw new Error('Explicit soft-budget acknowledgment required');
const caller = 'Quiero saber a qué hora cierran hoy.';
const modelId = 'google/gemma-4-31b-it';
const tts = new inference.TTS({
  model: 'fishaudio/s2.1-pro',
  voice: 'fa4c9eb3dccc4806b382b40d61c6b10a',
  language: 'es',
});
const stt = new inference.STT({ model: 'assemblyai/universal-3-6-pro', language: 'es-MX' });
const model = new inference.LLM({
  model: modelId,
  modelOptions: { max_completion_tokens: 120, temperature: 0 },
});
const report = {
  mode: 'synthetic direct-component voice smoke (not full realtime call)',
  models: { stt: 'assemblyai/universal-3-6-pro', llm: modelId, tts: 'fishaudio/s2.1-pro' },
  cost_ceiling_usd_soft: 1,
  stages: [],
  billable_calls_attempted: 0,
};
async function synthesize(text) {
  const stream = tts.stream();
  const frames = [];
  const start = performance.now();
  try {
    stream.pushText(text);
    stream.endInput();
    for await (const event of stream) if (event?.frame) frames.push(event.frame);
  } finally {
    stream.close();
  }
  const duration = frames.reduce((sum, f) => sum + f.samplesPerChannel / f.sampleRate, 0);
  return {
    frames,
    elapsed_ms: Math.round(performance.now() - start),
    duration_seconds: Math.round(duration * 100) / 100,
  };
}
const timeout = setTimeout(() => {
  console.error('SYNTHETIC_VOICE_TIMEOUT');
  process.exit(124);
}, 75000);
try {
  report.billable_calls_attempted++;
  const input = await synthesize(caller);
  report.stages.push({
    name: 'synthetic_input_tts',
    elapsed_ms: input.elapsed_ms,
    frames: input.frames.length,
    duration_seconds: input.duration_seconds,
  });
  if (!input.frames.length) throw new Error('No input speech frames');
  const speechStream = stt.stream();
  const begin = performance.now();
  const words = [];
  const events = [];
  try {
    for (const frame of input.frames) speechStream.pushFrame(frame);
    speechStream.endInput();
    for await (const event of speechStream) {
      events.push({
        type: String(event?.type),
        alts: (event?.alternatives || []).map((a) => String(a.text || '').slice(0, 100)),
      });
      if (event?.type === speech.SpeechEventType.FINAL_TRANSCRIPT) {
        for (const a of event.alternatives || []) if (a.text) words.push(a.text);
      }
    }
  } finally {
    speechStream.close();
  }
  const transcript = words.join(' ').trim();
  report.billable_calls_attempted++;
  const recognizedHours = /(?:hora|cierr|horario)/i.test(transcript);
  report.stages.push({
    name: 'stt',
    elapsed_ms: Math.round(performance.now() - begin),
    transcript,
    nonempty: !!transcript,
    recognized_intent: recognizedHours,
    events,
  });
  if (!recognizedHours) throw new Error('STT did not preserve caller intent');
  const src = fs.readFileSync('src/agent.ts', 'utf8');
  const match = src.match(/instructions:\s*dedent\x60([\s\S]*?)\x60/);
  if (!match || !src.includes("model: 'google/gemma-4-31b-it'"))
    throw new Error('Production agent mismatch');
  const chat = llm.ChatContext.empty();
  chat.addMessage({ role: 'system', content: match[1].trim() });
  chat.addMessage({ role: 'user', content: transcript });
  const llmStart = performance.now();
  report.billable_calls_attempted++;
  const response = await model.chat({ chatCtx: chat }).collect();
  report.stages.push({
    name: 'gemma',
    elapsed_ms: Math.round(performance.now() - llmStart),
    response: response.text || '',
    prompt_tokens: response.usage?.promptTokens ?? null,
    completion_tokens: response.usage?.completionTokens ?? null,
  });
  if (!response.text) throw new Error('No Gemma response');
  report.billable_calls_attempted++;
  const output = await synthesize(response.text.slice(0, 360));
  report.stages.push({
    name: 'response_tts',
    elapsed_ms: output.elapsed_ms,
    frames: output.frames.length,
    duration_seconds: output.duration_seconds,
  });
  if (!output.frames.length) throw new Error('No reply audio');
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error_class = e?.name || 'Error';
  report.error_message = String(e?.message || e).slice(0, 240);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await Promise.allSettled([model.aclose(), tts.close(), stt.close()]);
  fs.writeFileSync('livekit-voice-smoke.local.json', JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}
