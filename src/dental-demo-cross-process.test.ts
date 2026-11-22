import { DateTime } from 'luxon';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('demo calendar persists between separate LiveKit job processes', () => {
  it('prevents booking the same interval in a second process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-cross-process-'));
    const database = join(dir, 'calendar.sqlite');
    const local = DateTime.now().setZone('America/Tijuana');
    const daysUntilMonday = (1 - local.weekday + 7) % 7 || 7;
    const date = local.plus({ days: daysUntilMonday }).toISODate()!;
    const script = `
      import { getDemoScheduler } from './src/dental-demo.ts';
      const scheduler = getDemoScheduler();
      const date = process.argv[1];
      const result = await scheduler.book({
        service: 'limpieza', date, time: '13:00',
        patientName: 'Paciente Prueba', phone: '0000000000', confirmed: true,
      });
      console.log(JSON.stringify(result));
    `;
    const run = () =>
      JSON.parse(
        execFileSync(process.execPath, ['--input-type=module', '--eval', script, date], {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, DENTAL_DEMO_DB_PATH: database },
        }).trim(),
      ) as { status: string };
    try {
      expect(run().status).toBe('booked');
      expect(run().status).toBe('unavailable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
