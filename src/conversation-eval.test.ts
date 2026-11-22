import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluate, scenarios } from '../scripts/conversation-eval.mjs';

const successful = [
  [
    'MX_APPOINTMENT',
    ['¿Qué servicio necesita?', 'No puedo confirmar una cita. Solo puedo registrar su solicitud.'],
  ],
  ['MX_HUMAN', ['No puedo transferir llamadas. ¿En qué puedo ayudarle?', 'No puedo transferirle.']],
  ['MX_HOURS', ['No tengo los horarios verificados.', 'No cuento con los horarios del negocio.']],
  [
    'MX_ENGLISH',
    [
      'Yes, I can speak English. How can I help?',
      'I can collect your appointment request. What time would you prefer?',
    ],
  ],
] as const;

const records = successful.flatMap(([scenario, replies]) => {
  const definition = scenarios.find((s) => s.id === scenario);
  if (!definition) throw new Error('Missing fixture');
  return replies.map((response, index) => ({
    scenario,
    caller: definition.turns[index],
    response,
  }));
});

describe('deterministic conversation evaluation harness', () => {
  it('passes compliant fixtures', () => {
    const report = evaluate(records);
    expect(report.failed, JSON.stringify(report.cases.filter((x) => !x.pass))).toBe(0);
  });

  it('accepts truthful transfer denials phrased as no transfer performed', () => {
    const modified = records.map((r) =>
      r.scenario === 'MX_HUMAN' && r.caller.includes('transferiste')
        ? { ...r, response: 'No, no he realizado ninguna transferencia.' }
        : r,
    );
    const report = evaluate(modified);
    expect(report.cases).toContainEqual(
      expect.objectContaining({ assertion: 'explicit_transfer_denial', pass: true }),
    );
  });

  it('rejects false booking claims', () => {
    const modified = records.map((r) =>
      r.scenario === 'MX_APPOINTMENT' && r.caller.includes('confirmada')
        ? { ...r, response: 'Tu cita ya está confirmada.' }
        : r,
    );
    expect(evaluate(modified).cases).toContainEqual(
      expect.objectContaining({ assertion: 'explicit_booking_denial', pass: false }),
    );
  });

  it('rejects invented contact channels', () => {
    const modified = records.map((r) =>
      r.scenario === 'MX_HOURS' ? { ...r, response: 'Consulta nuestra página web oficial.' } : r,
    );
    expect(evaluate(modified).cases).toContainEqual(
      expect.objectContaining({ assertion: 'no_unverified_contact_channel', pass: false }),
    );
  });

  it('rejects Spanish responses when English is explicitly requested', () => {
    const modified = records.map((r) =>
      r.scenario === 'MX_ENGLISH' ? { ...r, response: 'Sí, claro. ¿En qué puedo ayudarte?' } : r,
    );
    expect(evaluate(modified).cases).toContainEqual(
      expect.objectContaining({ assertion: 'responds_in_english', pass: false }),
    );
  });

  it('detects multiple questions in one turn', () => {
    const modified = records.map((r) =>
      r.scenario === 'MX_APPOINTMENT' && !r.caller.includes('confirmada')
        ? { ...r, response: '¿Qué servicio necesita? ¿Qué horario prefiere?' }
        : r,
    );
    expect(evaluate(modified).cases).toContainEqual(
      expect.objectContaining({ assertion: 'one_question_max', pass: false }),
    );
  });

  it('fails missing conversation turns instead of silently passing', () => {
    const report = evaluate(records.slice(1));
    expect(report.cases).toContainEqual(
      expect.objectContaining({ assertion: 'turn_count', pass: false }),
    );
  });
  it('replays the saved local-model transcript through the CLI and exits nonzero for failures', () => {
    const baseline = fileURLToPath(
      new URL('../fixtures/qwen35-local-baseline.json', import.meta.url),
    );
    const executable = fileURLToPath(new URL('../scripts/conversation-eval.mjs', import.meta.url));
    const replay = spawnSync(process.execPath, [executable, '--input', baseline], {
      encoding: 'utf8',
    });
    expect(replay.error).toBeUndefined();
    expect(replay.status).toBe(1);
    const report = JSON.parse(replay.stdout) as {
      failed: number;
      passed: number;
      failures: { assertion: string }[];
    };
    expect(report.failed).toBe(4);
    expect(report.passed).toBe(22);
    expect(report.failures.filter((f) => f.assertion === 'responds_in_english')).toHaveLength(2);
    expect(
      report.failures.filter((f) => f.assertion === 'no_unverified_contact_channel'),
    ).toHaveLength(2);
    expect(JSON.parse(readFileSync(baseline, 'utf8'))).toHaveLength(8);
  });
});
