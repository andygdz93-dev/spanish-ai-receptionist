import { DateTime } from 'luxon';
import { type CalendarPort, type DentalConfig, DentalScheduler } from './dental-calendar.ts';

// Local-only demo. No Google API, no notifications, no real patient data, no disk writes.
// Deliberately resets when the worker restarts.
const timezone = 'America/Tijuana';
export const DEMO_OFFICE_NAME = 'Consultorio Dental de Prueba';
export const demoConfig: DentalConfig = {
  calendarId: 'demo-only-memory',
  officeEmail: 'no-email-sent.invalid',
  timezone,
  services: { limpieza: 60, consulta: 30, revisión: 30 },
  hours: {
    '1': [['09:00', '17:00']],
    '2': [['09:00', '17:00']],
    '3': [['09:00', '17:00']],
    '4': [['09:00', '17:00']],
    '5': [['09:00', '17:00']],
  },
  clientId: 'not-used',
  clientSecret: 'not-used',
  refreshToken: 'not-used',
};

type Interval = { start: string; end: string };
const appointments: Interval[] = [];
let nextDemoId = 1;
export const demoCalendarPort: CalendarPort = {
  async freeBusy() {
    return appointments.map((appointment) => ({ ...appointment }));
  },
  async insert(details) {
    // Avoid storing actual callers' names or telephone numbers, even if the LLM provides them.
    const start = DateTime.fromISO(details.start);
    const end = DateTime.fromISO(details.end);
    if (!start.isValid || !end.isValid || end <= start) throw new Error('Invalid demo slot');
    const overlaps = appointments.some(
      (entry) => DateTime.fromISO(entry.start) < end && DateTime.fromISO(entry.end) > start,
    );
    if (overlaps) throw new Error('Demo slot already occupied');
    appointments.push({ start: details.start, end: details.end });
    return { id: `DEMO-${nextDemoId++}` };
  },
};

const demoScheduler = new DentalScheduler(demoConfig, demoCalendarPort);
export function getDemoScheduler(): DentalScheduler {
  return demoScheduler;
}

export function resetDemoCalendarForTests(): void {
  appointments.length = 0;
  nextDemoId = 1;
}
