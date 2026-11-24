// Repeatable browser-only staging bookings. No patient records or phone routing.
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DateTime } from 'luxon';
import {
  GooglePilot, googlePilotCalendar, readPilotConfig,
  type PilotCalendar, type PilotConfig,
} from './pilot.ts';

export type StageBookingStatus =
  'booked'|'already_used'|'unavailable'|'confirmation_required'|'needs_reconciliation'|
  'disabled'|'limit_reached';
export type StageBookingResult = {
  status: StageBookingStatus;
  testOnly: true;
  realPatientBooking: false;
  date: string;
  time: string;
  savedInGoogleCalendar: boolean;
  retainedAfterHangup: boolean;
};

export type StageOptions = {
  isolatedEnv: NodeJS.ProcessEnv;
  originalEnv: NodeJS.ProcessEnv;
  stagingEnv: NodeJS.ProcessEnv;
  root: string;
  now?: () => DateTime;
  calendarFactory?: (config: PilotConfig) => PilotCalendar;
};

const MAX_STAGE_EVENTS = 20;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

export class StagingScheduler {
  private readonly options: StageOptions;
  constructor(options: StageOptions) {
    this.options = options;
    if (options.stagingEnv.VVS_STAGING_APPROVED !== 'yes' ||
        options.stagingEnv.VVS_STAGING_BROWSER_ONLY !== 'yes')
      throw new Error('Browser-only staging must be explicitly approved');
    if (!['yes','no'].includes(options.stagingEnv.VVS_STAGING_ALLOW_WRITES ?? ''))
      throw new Error('Staging write permission must be explicit');
    if (!options.stagingEnv.VVS_STAGING_AUDIT_DIR)
      throw new Error('Staging requires a private audit directory');
    if (!existsSync(options.stagingEnv.VVS_STAGING_AUDIT_DIR))
      throw new Error('Staging audit directory must already exist');
    if (options.isolatedEnv.VVS_PILOT_CALL_ROUTE_VERIFIED !== 'no' ||
        options.isolatedEnv.VVS_PILOT_BROWSER_ROUTE_VERIFIED !== 'yes')
      throw new Error('Only the isolated browser LiveKit project is allowed');
  }

  private config(date: string, time: string): PilotConfig {
    if (!datePattern.test(date) || !timePattern.test(time))
      throw new Error('Use date YYYY-MM-DD and time HH:mm in America/Tijuana');
    const file = date + '_' + time.replace(':', '') + '.json';
    const statePath = resolve(this.options.stagingEnv.VVS_STAGING_AUDIT_DIR!, file);
    const now = this.options.now?.() ?? DateTime.now();
    if (!now.isValid) throw new Error('Current time is invalid');
    return readPilotConfig({
      ...this.options.isolatedEnv,
      VVS_PILOT_TEST_DATE: date,
      VVS_PILOT_TEST_TIME: time,
      VVS_PILOT_STATE_PATH: statePath,
    }, this.options.originalEnv, this.options.root, now as DateTime<true>);
  }

  private pilot(date: string, time: string): GooglePilot {
    const config = this.config(date, time);
    return new GooglePilot(config,
      this.options.calendarFactory?.(config) ??
      googlePilotCalendar(config, { retainAfterCall: true }));
  }

  async availability(date: string, time: string): Promise<'available'|'busy'|'already_used'> {
    return this.pilot(date, time).availability();
  }

  async book(date: string, time: string, confirmed: boolean): Promise<StageBookingResult> {
    const result = (status: StageBookingStatus): StageBookingResult => ({
      status, date, time, testOnly: true, realPatientBooking: false,
      savedInGoogleCalendar: status === 'booked',
      retainedAfterHangup: status === 'booked',
    });
    if (!confirmed) return result('confirmation_required');
    if (this.options.stagingEnv.VVS_STAGING_ALLOW_WRITES !== 'yes')
      return result('disabled');
    const files = readdirSync(this.options.stagingEnv.VVS_STAGING_AUDIT_DIR!);
    if (files.filter(f => /^\d{4}-\d{2}-\d{2}_\d{4}\.json$/.test(f)).length >= MAX_STAGE_EVENTS)
      return result('limit_reached');
    const status = await this.pilot(date, time).book(true);
    return result(status);
  }

  auditPath(date: string, time: string): string {
    // Validate the slot as well as the audit filename.
    return this.config(date, time).statePath;
  }
}
