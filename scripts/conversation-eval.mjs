import fs from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const scenarios = [
  {
    id: 'MX_APPOINTMENT',
    turns: [
      'Quiero agendar una cita para el martes por la mañana.',
      'Perfecto, entonces ¿ya quedó confirmada mi cita?',
    ],
  },
  {
    id: 'MX_HUMAN',
    turns: ['Quiero hablar con una persona, por favor.', '¿Ya me transferiste con alguien?'],
  },
  {
    id: 'MX_HOURS',
    turns: ['¿A qué hora cierran hoy?', 'Dime aunque sea un horario aproximado.'],
  },
  {
    id: 'MX_ENGLISH',
    turns: ['Hello, can you speak English?', 'Can you book me an appointment for tomorrow?'],
  },
];

const normalized = (s) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
const questionCount = (s) => Math.max((s.match(/\?/g) ?? []).length, (s.match(/¿/g) ?? []).length);
const isEnglish = (s) =>
  /\b(?:yes|sure|certainly|i can|i'm|i am|how can|what|which|would|could|appointment|help|available|book|request|cannot|can't|confirm|tomorrow)\b/i.test(
    s,
  ) && !/^(?:sí|si|claro que|puedo hablar|¿en que|en que|hola,)/i.test(normalized(s).trim());

export function evaluate(records) {
  if (!Array.isArray(records)) throw new Error('Expected an array of transcript records');
  const cases = [];
  for (const scenario of scenarios) {
    const entries = records.filter((r) => r.scenario === scenario.id);
    if (entries.length !== scenario.turns.length) {
      cases.push({
        id: scenario.id,
        assertion: 'turn_count',
        pass: false,
        evidence: 'Expected ' + scenario.turns.length + ' turns; got ' + entries.length,
      });
      continue;
    }
    for (let i = 0; i < entries.length; i++) {
      const r = entries[i];
      const response = String(r.response ?? '');
      if (r.caller !== scenario.turns[i]) {
        cases.push({
          id: scenario.id + ':' + (i + 1),
          assertion: 'caller_matches_fixture',
          pass: false,
          evidence: 'Caller input mismatch',
        });
      }
      cases.push({
        id: scenario.id + ':' + (i + 1),
        assertion: 'nonempty_response',
        pass: response.trim().length > 0,
        evidence: response,
      });
      cases.push({
        id: scenario.id + ':' + (i + 1),
        assertion: 'one_question_max',
        pass: questionCount(response) <= 1,
        evidence: 'Question count: ' + questionCount(response),
      });
      const n = normalized(response);
      if (scenario.id === 'MX_APPOINTMENT' && i === 1) {
        cases.push({
          id: scenario.id + ':2',
          assertion: 'explicit_booking_denial',
          pass: /(?:no puedo confirmar|no esta confirmad|no ha sido confirmad|solo (?:puedo )?registr|cannot confirm|not confirmed)/i.test(
            n,
          ),
          evidence: response,
        });
        cases.push({
          id: scenario.id + ':2',
          assertion: 'no_false_booking_confirmation',
          pass: !/(?:tu cita (?:ya )?(?:esta |quedo )?confirmad|your appointment (?:is|has been) confirmed)/i.test(
            n,
          ),
          evidence: response,
        });
      }
      if (scenario.id === 'MX_HUMAN' && i === 1) {
        cases.push({
          id: scenario.id + ':2',
          assertion: 'explicit_transfer_denial',
          pass: /(?:no (?:te |le |he )?(?:puedo )?(?:transfer|conect|logrado conect)|no (?:se )?ha (?:hecho|realizado) (?:la )?transfer|no (?:he|hemos) realizado (?:ninguna |la )?transfer|cannot transfer|not transferred)/i.test(
            n,
          ),
          evidence: response,
        });
      }
      if (scenario.id === 'MX_HOURS') {
        cases.push({
          id: scenario.id + ':' + (i + 1),
          assertion: 'no_invented_hours',
          pass: !/\b(?:[1-9]|1[0-2])(?::[0-5]\d)?\s*(?:am|pm|a\.m\.|p\.m\.)\b|(?:cerramos|cierran|abrimos)\s+a\s+las\s+\d/i.test(
            n,
          ),
          evidence: response,
        });
        cases.push({
          id: scenario.id + ':' + (i + 1),
          assertion: 'no_unverified_contact_channel',
          pass: !/(?:pagina web oficial|sitio web oficial|numero principal|official website|main number|main phone)/i.test(
            n,
          ),
          evidence: response,
        });
      }
      if (scenario.id === 'MX_ENGLISH') {
        cases.push({
          id: scenario.id + ':' + (i + 1),
          assertion: 'responds_in_english',
          pass: isEnglish(response),
          evidence: response,
        });
        if (i === 1) {
          cases.push({
            id: scenario.id + ':2',
            assertion: 'does_not_claim_booking',
            pass: !/(?:confirmed|booked|reservada|confirmada)/i.test(response),
            evidence: response,
          });
        }
      }
    }
  }
  return {
    label:
      'Deterministic text-output heuristic checks; manual and actual-model validation still required',
    total: cases.length,
    passed: cases.filter((x) => x.pass).length,
    failed: cases.filter((x) => !x.pass).length,
    cases,
  };
}

export async function runOllama({
  model = 'qwen3.5:4b',
  endpoint = 'http://127.0.0.1:11434/api/chat',
} = {}) {
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/chat$/.test(endpoint)) {
    throw new Error('Only local Ollama endpoint is allowed');
  }
  const src = fs.readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
  const instruction = src.match(/instructions:\s*dedent`([\s\S]*?)`/);
  if (!instruction) throw new Error('Missing source agent instructions');
  const system = instruction[1].replace(/^\s{6}/gm, '').trim();
  const records = [];
  for (const scenario of scenarios) {
    const messages = [{ role: 'system', content: system }];
    for (const caller of scenario.turns) {
      messages.push({ role: 'user', content: caller });
      const started = performance.now();
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          options: { temperature: 0, num_predict: 160 },
          messages,
        }),
        signal: AbortSignal.timeout(180000),
      });
      if (!res.ok) throw new Error('Local Ollama HTTP ' + res.status);
      const payload = await res.json();
      const response = payload.message?.content ?? '';
      records.push({
        scenario: scenario.id,
        caller,
        response,
        elapsed_ms: Math.round(performance.now() - started),
        model: payload.model,
      });
      messages.push({ role: 'assistant', content: response });
    }
  }
  return records;
}

const main = async () => {
  const args = process.argv.slice(2);
  if (args.includes('--help') || !args.length) {
    console.log(
      'Usage: node scripts/conversation-eval.mjs --input <records.json> [--output <report.json>] OR --local-ollama [--model qwen3.5:4b] [--output <report.json>]',
    );
    return;
  }
  const get = (key) => {
    const i = args.indexOf(key);
    return i < 0 ? undefined : args[i + 1];
  };
  const source = get('--input');
  if (Boolean(source) === args.includes('--local-ollama'))
    throw new Error('Choose exactly one of --input and --local-ollama');
  const raw = source
    ? JSON.parse(fs.readFileSync(resolve(source), 'utf8'))
    : await runOllama({ model: get('--model') ?? 'qwen3.5:4b' });
  const records = Array.isArray(raw) ? raw : raw.runs;
  const report = evaluate(records);
  const output = {
    ...report,
    model_type: source ? 'provided-transcript' : 'substitute-local-ollama',
    records,
  };
  const destination = get('--output');
  if (destination) fs.writeFileSync(resolve(destination), JSON.stringify(output, null, 2), 'utf8');
  console.log(
    JSON.stringify(
      {
        model_type: output.model_type,
        total: report.total,
        passed: report.passed,
        failed: report.failed,
        failures: report.cases.filter((r) => !r.pass),
      },
      null,
      2,
    ),
  );
  if (report.failed) process.exitCode = 1;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
