import { DateTime } from 'luxon';
import { afterEach, describe, expect, it } from 'vitest';
import {
  demoCalendarPort,
  demoConfig,
  getDemoScheduler,
  resetDemoCalendarForTests,
} from './dental-demo.ts';

afterEach(() => resetDemoCalendarForTests());
function nextMonday() {
  const now = DateTime.now().setZone(demoConfig.timezone);
  const days = (8 - now.weekday) % 7 || 7;
  return now.plus({ days }).toFormat('yyyy-MM-dd');
}

describe('offline fake dental-office calendar', () => {
  it('exposes fictional-only configuration', () => {
    expect(demoConfig.calendarId).toBe('demo-only-memory');
    expect(demoConfig.officeEmail).toContain('.invalid');
    expect(demoConfig.services.limpieza).toBe(60);
  });

  it('offers future slots and simulates one booking without contacting Google or an office', async () => {
    const scheduler = getDemoScheduler();
    const date = nextMonday();
    const slots = await scheduler.availableSlots('limpieza', date);
    expect(slots).toContain('09:00');
    const data = {
      service: 'limpieza',
      date,
      time: '09:00',
      patientName: 'Paciente Prueba',
      phone: '0000000000',
      confirmed: true,
    };
    const first = await scheduler.book(data);
    expect(first.status).toBe('booked');
    expect(first.eventId).toMatch(/^DEMO-/);
    expect(await scheduler.book(data)).toEqual({ status: 'unavailable' });
    resetDemoCalendarForTests();
    expect(await scheduler.availableSlots('limpieza', date)).toContain('09:00');
  });

  it('keeps patient details out of the fake calendar store', async () => {
    const date = nextMonday();
    await demoCalendarPort.insert({
      calendarId: 'demo-only-memory',
      officeEmail: 'no-email-sent.invalid',
      timezone: demoConfig.timezone,
      start: `${date}T09:00:00-08:00`,
      end: `${date}T10:00:00-08:00`,
      service: 'limpieza',
      patientName: 'PERSONAL NAME',
      phone: 'SECRET PHONE',
    });
    expect(JSON.stringify(await demoCalendarPort.freeBusy('', '', ''))).not.toMatch(
      /PERSONAL NAME|SECRET PHONE/,
    );
  });
});
