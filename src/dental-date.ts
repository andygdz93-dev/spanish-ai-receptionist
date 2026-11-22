import { DateTime } from 'luxon';

export type DateCheck =
  | { valid: true; today: string; weekday: string }
  | {
      valid: false;
      reason: 'invalid_date' | 'past_date' | 'too_far';
      today: string;
      nextBusinessDay: string;
    };

// Validates dates in the business's calendar timezone, not the model's assumed year.
// Never silently turn a past date into a new one; let the caller confirm the corrected date.
export function validateAppointmentDate(
  date: string,
  timezone: string,
  now = DateTime.now(),
): DateCheck {
  const localNow = now.setZone(timezone);
  const today = localNow.toISODate()!;
  let nextBusiness = localNow.plus({ days: 1 }).startOf('day');
  while (nextBusiness.weekday > 5) nextBusiness = nextBusiness.plus({ days: 1 });
  const nextBusinessDay = nextBusiness.toISODate()!;
  const requested = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? DateTime.fromISO(date, { zone: timezone })
    : DateTime.invalid('bad format');
  if (!requested.isValid || requested.toISODate() !== date) {
    return { valid: false, reason: 'invalid_date', today, nextBusinessDay };
  }
  if (requested < localNow.startOf('day')) {
    return { valid: false, reason: 'past_date', today, nextBusinessDay };
  }
  if (requested > localNow.plus({ days: 90 }).endOf('day')) {
    return { valid: false, reason: 'too_far', today, nextBusinessDay };
  }
  return { valid: true, today, weekday: requested.setLocale('es').toFormat('cccc') };
}
