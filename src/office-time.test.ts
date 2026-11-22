import { describe, expect, it } from 'vitest';
import { getOfficeDateContext } from './office-time.ts';

describe('office clock (America/Tijuana)', () => {
  it('uses the real 2026 calendar date, not a hardcoded year', () => {
    expect(getOfficeDateContext(new Date('2026-11-22T20:00:00Z')))
      .toContain('2026-11-22 (domingo)');
  });

  it('does not switch to tomorrow at UTC midnight', () => {
    expect(getOfficeDateContext(new Date('2026-11-23T06:30:00Z')))
      .toContain('2026-11-22 (domingo)');
  });

  it('rolls over to Monday at local midnight', () => {
    expect(getOfficeDateContext(new Date('2026-11-23T08:00:00Z')))
      .toContain('2026-11-23 (lunes)');
  });

  it('handles daylight saving time in summer', () => {
    expect(getOfficeDateContext(new Date('2026-07-01T19:15:00Z')))
      .toContain('Hora local: 12:15:00');
  });

  it('uses standard time in November', () => {
    expect(getOfficeDateContext(new Date('2026-11-22T20:15:00Z')))
      .toContain('Hora local: 12:15:00');
  });
});
