import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import {
  type CalendarPort,
  type DentalConfig,
  DentalScheduler,
  readDentalConfig,
} from './dental-calendar.ts';

const config: DentalConfig = {
  calendarId: 'clinic@example.com',
  officeEmail: 'reception@example.com',
  timezone: 'America/Tijuana',
  services: { limpieza: 60 },
  hours: { '1': [['09:00', '12:00']], '2': [['09:00', '12:00']] },
  clientId: 'fake',
  clientSecret: 'fake',
  refreshToken: 'fake',
};
const today = () => DateTime.fromISO('2026-11-23T07:00:00', { zone: config.timezone });
function mockPort() {
  const busy: Array<{ start: string; end: string }> = [];
  const freeBusy = vi.fn(async () => busy);
  const insert = vi.fn(async () => {
    busy.push({ start: '2026-11-23T09:00:00-08:00', end: '2026-11-23T10:00:00-08:00' });
    return { id: 'event-test-1' };
  });
  return { busy, freeBusy, insert, port: { freeBusy, insert } as CalendarPort };
}
describe('dental calendar adapter - no network calls', () => {
  it('remains disabled without explicit office authorization and configuration', () => {
    expect(readDentalConfig({})).toBeNull();
    expect(readDentalConfig({ DENTAL_BOOKINGS_ENABLED: 'yes' })).toBeNull();
  });
  it('excludes busy windows and slots outside configured hours', async () => {
    const m = mockPort();
    m.busy.push({ start: '2026-11-23T10:00:00-08:00', end: '2026-11-23T11:00:00-08:00' });
    const slots = await new DentalScheduler(config, m.port, today).availableSlots(
      'limpieza',
      '2026-11-23',
    );
    expect(slots).toEqual([]); // 09:00 buffer overlaps 10:00 busy; 11:00 buffer exceeds closing.
    expect(m.freeBusy).toHaveBeenCalledOnce();
  });
  it('rejects unverified or malformed reservations without writing', async () => {
    const m = mockPort();
    const scheduler = new DentalScheduler(config, m.port, today);
    const details = {
      service: 'limpieza',
      date: '2026-11-23',
      time: '09:00',
      patientName: 'Ana',
      phone: '5551234567',
    };
    expect(await scheduler.book({ ...details, confirmed: false })).toEqual({ status: 'invalid' });
    expect(await scheduler.book({ ...details, time: '08:00', confirmed: true })).toEqual({
      status: 'unavailable',
    });
    expect(m.insert).not.toHaveBeenCalled();
  });
  it('creates a booked event after explicit confirmation and refuses a second conflicting booking', async () => {
    const m = mockPort();
    const scheduler = new DentalScheduler(config, m.port, today);
    const details = {
      service: 'limpieza',
      date: '2026-11-23',
      time: '09:00',
      patientName: 'Ana',
      phone: '5551234567',
      confirmed: true,
    };
    expect(await scheduler.book(details)).toEqual({ status: 'booked', eventId: 'event-test-1' });
    expect(await scheduler.book(details)).toEqual({ status: 'unavailable' });
    expect(m.insert).toHaveBeenCalledOnce();
    expect(m.insert.mock.calls[0][0].officeEmail).toBe('reception@example.com');
  });
  it('fails closed when calendar availability cannot be retrieved', async () => {
    const port: CalendarPort = {
      freeBusy: async () => {
        throw new Error('offline');
      },
      insert: vi.fn(),
    };
    await expect(
      new DentalScheduler(config, port, today).availableSlots('limpieza', '2026-11-23'),
    ).rejects.toThrow('offline');
    expect(port.insert).not.toHaveBeenCalled();
  });
});
