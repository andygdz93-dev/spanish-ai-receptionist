import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { findNextAvailableDates } from './next-availability.ts';
const zone = 'America/Tijuana';
const now = DateTime.fromISO('2026-11-23T08:00:00', { zone });
describe('next real availability', () => {
  it('skips full and closed days and returns verified times', async () => {
    const availableSlots = vi.fn(async (_service: string, date: string) => date === '2026-11-25' ? ['10:00','11:00'] : date === '2026-11-27' ? ['09:00'] : []);
    const result = await findNextAvailableDates({ availableSlots }, 'limpieza', zone, '2026-11-23', now, 2);
    expect(result).toEqual([{ date: '2026-11-25', slots: ['10:00','11:00'] }, { date: '2026-11-27', slots: ['09:00'] }]);
    expect(availableSlots).toHaveBeenCalledWith('limpieza', '2026-11-24');
  });
  it('never searches beyond the scheduler 30-day horizon', async () => {
    const availableSlots = vi.fn(async () => []);
    expect(await findNextAvailableDates({ availableSlots }, 'consulta', zone, '2026-12-23', now)).toEqual([]);
    expect(availableSlots).toHaveBeenCalledTimes(1);
  });
  it('propagates calendar outage instead of claiming no dates', async () => {
    const availableSlots = vi.fn(async () => { throw Error('calendar offline'); });
    await expect(findNextAvailableDates({ availableSlots }, 'consulta', zone, '2026-11-23', now)).rejects.toThrow('calendar offline');
  });
  it('rejects invalid dates and starts from today for a past date', async () => {
    const availableSlots = vi.fn(async () => ['09:00']);
    await expect(findNextAvailableDates({ availableSlots }, 'consulta', zone, 'bad', now)).rejects.toThrow('invalid_date');
    expect((await findNextAvailableDates({ availableSlots }, 'consulta', zone, '2026-11-20', now, 1))[0].date).toBe('2026-11-23');
  });
});
