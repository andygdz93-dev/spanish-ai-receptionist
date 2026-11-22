import { google } from 'googleapis';
import { DateTime } from 'luxon';

export type DentalConfig = {
  calendarId: string;
  officeEmail: string;
  timezone: string;
  services: Record<string, number>;
  hours: Record<string, [string, string][]>;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

export type CalendarPort = {
  freeBusy: (
    start: string,
    end: string,
    calendarId: string,
  ) => Promise<Array<{ start: string; end: string }>>;
  insert: (details: {
    calendarId: string;
    officeEmail: string;
    timezone: string;
    start: string;
    end: string;
    service: string;
    patientName: string;
    phone: string;
  }) => Promise<{ id: string }>;
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export function readDentalConfig(env: NodeJS.ProcessEnv = process.env): DentalConfig | null {
  if (env.DENTAL_BOOKINGS_ENABLED !== 'yes') return null;
  const keys = [
    'DENTAL_CALENDAR_ID',
    'DENTAL_OFFICE_EMAIL',
    'DENTAL_TIMEZONE',
    'DENTAL_SERVICES_JSON',
    'DENTAL_HOURS_JSON',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REFRESH_TOKEN',
  ] as const;
  if (keys.some((key) => !env[key]?.trim())) return null;
  try {
    const timezone = env.DENTAL_TIMEZONE!;
    if (!DateTime.now().setZone(timezone).isValid || !isValidEmail(env.DENTAL_OFFICE_EMAIL!))
      return null;
    const services = JSON.parse(env.DENTAL_SERVICES_JSON!) as Record<string, number>;
    const hours = JSON.parse(env.DENTAL_HOURS_JSON!) as Record<string, [string, string][]>;
    if (
      !services ||
      !Object.keys(services).length ||
      Object.entries(services).some(
        ([name, minutes]) => !name || !Number.isInteger(minutes) || minutes < 15 || minutes > 240,
      )
    )
      return null;
    if (
      !hours ||
      !Object.values(hours).length ||
      Object.entries(hours).some(
        ([day, spans]) =>
          !/^[0-6]$/.test(day) ||
          !Array.isArray(spans) ||
          spans.some(
            (span) =>
              !Array.isArray(span) ||
              span.length !== 2 ||
              !timePattern.test(span[0]) ||
              !timePattern.test(span[1]) ||
              span[0] >= span[1],
          ),
      )
    )
      return null;
    return {
      calendarId: env.DENTAL_CALENDAR_ID!,
      officeEmail: env.DENTAL_OFFICE_EMAIL!,
      timezone,
      services,
      hours,
      clientId: env.GOOGLE_CLIENT_ID!,
      clientSecret: env.GOOGLE_CLIENT_SECRET!,
      refreshToken: env.GOOGLE_REFRESH_TOKEN!,
    };
  } catch {
    return null;
  }
}

export function googleCalendarPort(config: DentalConfig): CalendarPort {
  const auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
  auth.setCredentials({ refresh_token: config.refreshToken });
  const calendar = google.calendar({ version: 'v3', auth });
  return {
    async freeBusy(start, end, calendarId) {
      const result = await calendar.freebusy.query({
        requestBody: { timeMin: start, timeMax: end, items: [{ id: calendarId }] },
      });
      const entry = result.data.calendars?.[calendarId];
      if (!entry || entry.errors?.length) throw new Error('Calendar availability unavailable');
      return (entry.busy ?? []).map((b) => {
        if (!b.start || !b.end) throw new Error('Malformed busy interval');
        return { start: b.start, end: b.end };
      });
    },
    async insert(details) {
      const result = await calendar.events.insert({
        calendarId: details.calendarId,
        sendUpdates: 'all',
        requestBody: {
          summary: 'Cita dental',
          description: `Paciente: ${details.patientName}\nTeléfono: ${details.phone}\nServicio solicitado: ${details.service}`,
          start: { dateTime: details.start, timeZone: details.timezone },
          end: { dateTime: details.end, timeZone: details.timezone },
          attendees: [{ email: details.officeEmail }],
          visibility: 'private',
        },
      });
      if (!result.data.id || result.data.status === 'cancelled')
        throw new Error('Calendar event creation unconfirmed');
      return { id: result.data.id };
    },
  };
}

function parseLocal(date: string, time: string, timezone: string): DateTime | null {
  if (!datePattern.test(date) || !timePattern.test(time)) return null;
  const result = DateTime.fromISO(`${date}T${time}`, { zone: timezone });
  return result.isValid &&
    result.toFormat('yyyy-MM-dd') === date &&
    result.toFormat('HH:mm') === time
    ? result
    : null;
}

export class DentalScheduler {
  private bookingLock: Promise<void> = Promise.resolve();
  private config: DentalConfig;
  private api: CalendarPort;
  private now: () => DateTime;
  constructor(config: DentalConfig, api: CalendarPort, now = () => DateTime.now()) {
    this.config = config;
    this.api = api;
    this.now = now;
  }

  async availableSlots(service: string, date: string): Promise<string[]> {
    const minutes = this.config.services[service.toLowerCase().trim()];
    if (!minutes || !datePattern.test(date)) return [];
    const midnight = parseLocal(date, '00:00', this.config.timezone);
    if (!midnight) return [];
    const windows = this.config.hours[String(midnight.weekday % 7)] ?? [];
    if (!windows.length) return [];
    const intervals = windows.map(([start, end]) => ({
      start: parseLocal(date, start, this.config.timezone),
      end: parseLocal(date, end, this.config.timezone),
    }));
    if (intervals.some((x) => !x.start || !x.end)) return [];
    const startDay = midnight.toUTC().toISO()!;
    const endDay = midnight.plus({ days: 1 }).toUTC().toISO()!;
    const busy = await this.api.freeBusy(startDay, endDay, this.config.calendarId);
    const occupied = busy.map((item) => ({
      start: DateTime.fromISO(item.start),
      end: DateTime.fromISO(item.end),
    }));
    if (
      occupied.some((item) => !item.start.isValid || !item.end.isValid || item.end <= item.start)
    ) {
      throw new Error('Invalid calendar busy data');
    }
    return intervals.flatMap(({ start, end }) => {
      const slots: string[] = [];
      for (
        let cursor = start!;
        cursor.plus({ minutes }) <= end!;
        cursor = cursor.plus({ minutes: 30 })
      ) {
        const finish = cursor.plus({ minutes });
        if (cursor <= this.now().setZone(this.config.timezone).plus({ hours: 1 })) continue;
        if (occupied.some((item) => item.start < finish && item.end > cursor)) continue;
        slots.push(cursor.toFormat('HH:mm'));
      }
      return slots;
    });
  }

  async book(input: {
    service: string;
    date: string;
    time: string;
    patientName: string;
    phone: string;
    confirmed: boolean;
  }): Promise<{ status: 'booked' | 'unavailable' | 'invalid'; eventId?: string }> {
    if (
      !input.confirmed ||
      !input.patientName.trim() ||
      !input.phone.trim() ||
      input.patientName.length > 100 ||
      input.phone.length > 40
    )
      return { status: 'invalid' };
    const service = input.service.toLowerCase().trim();
    const start = parseLocal(input.date, input.time, this.config.timezone);
    const minutes = this.config.services[service];
    if (!start || !minutes) return { status: 'invalid' };
    const previous = this.bookingLock;
    let release!: () => void;
    this.bookingLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      // Single-worker lock plus a fresh free/busy check. Multiple workers need distributed locking.
      if (!(await this.availableSlots(service, input.date)).includes(input.time))
        return { status: 'unavailable' };
      const result = await this.api.insert({
        calendarId: this.config.calendarId,
        officeEmail: this.config.officeEmail,
        timezone: this.config.timezone,
        start: start.toISO()!,
        end: start.plus({ minutes }).toISO()!,
        service,
        patientName: input.patientName.trim(),
        phone: input.phone.trim(),
      });
      return { status: 'booked', eventId: result.id };
    } finally {
      release();
    }
  }
}
