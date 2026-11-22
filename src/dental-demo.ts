import { DateTime } from 'luxon';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type CalendarPort, type DentalConfig, DentalScheduler } from './dental-calendar.ts';

// Shared by all LiveKit job processes on this one machine. Demo data contains
// only time intervals and synthetic booking IDs; never store patient details.
// A separate SQLite file per test process prevents parallel test interference.
const databasePath =
  process.env.DENTAL_DEMO_DB_PATH ??
  (process.env.VITEST
    ? resolve(tmpdir(), `dental-demo-test-${process.pid}.sqlite`)
    : resolve(process.cwd(), '.demo-appointments.sqlite'));

let database: DatabaseSync | undefined;
function getDatabase(): DatabaseSync {
  if (!database) {
    database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        CHECK (end_ms > start_ms)
      );
      CREATE INDEX IF NOT EXISTS idx_demo_appointment_times
        ON appointments(start_ms, end_ms);
    `);
  }
  return database;
}

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

export const demoCalendarPort: CalendarPort = {
  async freeBusy() {
    const rows = getDatabase()
      .prepare('SELECT start_ms, end_ms FROM appointments ORDER BY start_ms')
      .all() as Array<{ start_ms: number; end_ms: number }>;
    return rows.map(({ start_ms, end_ms }) => ({
      start: new Date(start_ms).toISOString(),
      end: new Date(end_ms).toISOString(),
    }));
  },
  async insert(details) {
    // SQL transaction prevents overlapping inserts across separate job processes.
    // Never persist actual caller names or phone numbers.
    const start = DateTime.fromISO(details.start);
    const end = DateTime.fromISO(details.end);
    if (!start.isValid || !end.isValid || end <= start) throw new Error('Invalid demo slot');
    const db = getDatabase();
    db.exec('BEGIN IMMEDIATE');
    try {
      const overlap = db
        .prepare('SELECT 1 AS taken FROM appointments WHERE start_ms < ? AND end_ms > ? LIMIT 1')
        .get(end.toMillis(), start.toMillis());
      if (overlap) throw new Error('Demo slot already occupied');
      const result = db
        .prepare('INSERT INTO appointments (start_ms, end_ms) VALUES (?, ?)')
        .run(start.toMillis(), end.toMillis());
      db.exec('COMMIT');
      return { id: `DEMO-${result.lastInsertRowid}` };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  },
};

const demoScheduler = new DentalScheduler(demoConfig, demoCalendarPort);
export function getDemoScheduler(): DentalScheduler {
  return demoScheduler;
}

export function resetDemoCalendarForTests(): void {
  if (!process.env.VITEST) {
    throw new Error('Demo calendar reset is restricted to tests');
  }
  getDatabase().exec(
    "DELETE FROM appointments; DELETE FROM sqlite_sequence WHERE name = 'appointments';",
  );
}
