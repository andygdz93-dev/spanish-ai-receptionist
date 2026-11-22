import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { validateAppointmentDate } from './dental-date.ts';

const now = DateTime.fromISO('2026-11-22T10:40:00', { zone: 'America/Tijuana' });
describe('dental appointment date validation', () => {
  it('rejects stale 2025 dates from the AI, offering an actual 2026 date', () => {
    expect(validateAppointmentDate('2025-05-19', 'America/Tijuana', now)).toEqual({
      valid: false,
      reason: 'past_date',
      today: '2026-11-22',
      nextBusinessDay: '2026-11-23',
    });
    expect(validateAppointmentDate('2025-05-20', 'America/Tijuana', now).valid).toBe(false);
    expect(validateAppointmentDate('2025-05-21', 'America/Tijuana', now).valid).toBe(false);
  });
  it('accepts actual future Monday and correctly labels its weekday', () => {
    expect(validateAppointmentDate('2026-11-23', 'America/Tijuana', now)).toEqual({
      valid: true,
      today: '2026-11-22',
      weekday: 'lunes',
    });
  });
  it('rejects invalid and distant calendar dates instead of lying about availability', () => {
    expect(validateAppointmentDate('2026-11-31', 'America/Tijuana', now)).toMatchObject({
      valid: false,
      reason: 'invalid_date',
    });
    expect(validateAppointmentDate('2027-12-31', 'America/Tijuana', now)).toMatchObject({
      valid: false,
      reason: 'too_far',
    });
  });
});
