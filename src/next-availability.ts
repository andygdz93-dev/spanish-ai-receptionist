import { DateTime } from 'luxon';
import type { DentalScheduler } from './dental-calendar.ts';

// Search only the scheduler's supported 30-day local calendar horizon.
// Errors propagate: an unreachable calendar must never be reported as fully booked.
export async function findNextAvailableDates(
  scheduler: Pick<DentalScheduler, 'availableSlots'>,
  service: string,
  timezone: string,
  fromDate: string,
  now: DateTime = DateTime.now(),
  maxDates = 3,
): Promise<Array<{ date: string; slots: string[] }>> {
  const today = now.setZone(timezone).startOf('day');
  const requested = DateTime.fromISO(fromDate, { zone: timezone });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !requested.isValid || requested.toISODate() !== fromDate) {
    throw new Error('invalid_date');
  }
  const start = requested < today ? today : requested.startOf('day');
  const end = today.plus({ days: 30 });
  const matches: Array<{ date: string; slots: string[] }> = [];
  for (let day = start; day <= end && matches.length < maxDates; day = day.plus({ days: 1 })) {
    const date = day.toISODate()!;
    const slots = await scheduler.availableSlots(service, date);
    if (slots.length) matches.push({ date, slots: slots.slice(0, 5) });
  }
  return matches;
}
