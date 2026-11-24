import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { phoneTestArmed, readPhoneTestConfig } from './phone-config.ts';
import { PILOT_CALENDAR_ID } from './pilot.ts';

const tempDirs: string[] = [];
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'vvs-phone-test-'));
  tempDirs.push(folder);
  const repo = join(folder, 'repo');
  mkdirSync(repo);
  const stageState = join(folder, 'prior-browser.json');
  const phoneState = join(folder, 'new-phone.json');
  writeFileSync(stageState, JSON.stringify({
    version: 1, eventId: 'vvstest' + 'a'.repeat(24),
    start: '2026-11-24T22:00:00.000Z', end: '2026-11-24T23:15:00.000Z',
    status: 'cleaned', createdAt: '2026-11-23T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z',
    writeVerifiedAt: '2026-11-23T00:01:00.000Z',
    cleanupVerifiedAt: '2026-11-23T00:02:00.000Z',
  }));
  const stage = {
    VVS_RUNTIME_PROFILE: 'google-pilot',
    VVS_GOOGLE_PILOT_APPROVED: 'yes',
    VVS_PILOT_PROJECT_REVIEWED: 'yes',
    VVS_PILOT_BROWSER_ROUTE_VERIFIED: 'yes',
    VVS_PILOT_CALL_ROUTE_VERIFIED: 'no',
    DENTAL_DEMO_MODE: 'no', DENTAL_BOOKINGS_ENABLED: 'no',
    HQ_TELEMETRY_PRODUCER_ENABLED: 'no',
    DENTAL_CALENDAR_ID: PILOT_CALENDAR_ID,
    GOOGLE_CLIENT_ID: 'fictional-client',
    GOOGLE_CLIENT_SECRET: 'fictional-secret',
    GOOGLE_REFRESH_TOKEN: 'fictional-token',
    LIVEKIT_URL: 'wss://isolated.livekit.cloud',
    VVS_PILOT_LIVEKIT_URL: 'wss://isolated.livekit.cloud',
    LIVEKIT_API_KEY: 'stage-test-key',
    LIVEKIT_API_SECRET: 'stage-test-secret',
    VVS_PILOT_HEALTH_PORT: '18082',
    VVS_PILOT_TEST_DATE: '2026-11-24',
    VVS_PILOT_TEST_TIME: '14:00',
    VVS_PILOT_STATE_PATH: stageState,
  };
  const original = {
    LIVEKIT_URL: 'wss://original.livekit.cloud',
    LIVEKIT_API_KEY: 'original-test-key',
    LIVEKIT_API_SECRET: 'original-test-secret',
  };
  const phone = {
    VVS_PHONE_TEST_PREPARED: 'yes',
    VVS_PHONE_TEST_ROUTE_ACTIVE: 'no',
    VVS_PHONE_TEST_EXPECTED_RULE_ID: 'SDR_abcdef123',
    VVS_PHONE_TEST_CALLED_NUMBER: '+12402128082',
    VVS_PHONE_TEST_HEALTH_PORT: '18083',
    VVS_PHONE_TEST_DATE: '2026-11-25',
    VVS_PHONE_TEST_TIME: '10:00',
    VVS_PHONE_TEST_STATE_PATH: phoneState,
  };
  const now = DateTime.fromISO('2026-11-23T07:00:00', { zone: 'America/Tijuana' });
  const verify = () => readPhoneTestConfig(phone, stage, original, repo, now);
  return { folder, repo, phone, stage, original, stageState, phoneState, verify };
}

afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('existing-number phone test bridge remains isolated and reversible', () => {
  it('uses original LiveKit project but a fresh Google one-use ledger', () => {
    const f = fixture();
    const result = f.verify();
    expect(result.pilot.livekitUrl).toBe(f.original.LIVEKIT_URL);
    expect(result.pilot.livekitKey).toBe(f.original.LIVEKIT_API_KEY);
    expect(result.pilot.clientId).toBe(f.stage.GOOGLE_CLIENT_ID);
    expect(result.pilot.statePath).toBe(f.phoneState);
    expect(result.pilot.healthPort).toBe(18083);
    expect(result.expectedCalledNumber).toBe('+12402128082');
  });

  it('allows child job import while armed but rejects missing state, wrong rule or phone', () => {
    const f = fixture();
    f.phone.VVS_PHONE_TEST_PREPARED = 'no';
    expect(f.verify).toThrow('not prepared');
    f.phone.VVS_PHONE_TEST_PREPARED = 'yes';
    f.phone.VVS_PHONE_TEST_ROUTE_ACTIVE = 'yes';
    expect(f.verify).not.toThrow(); // Critical: called in LiveKit per-call child subprocess.
    f.phone.VVS_PHONE_TEST_ROUTE_ACTIVE = 'invalid';
    expect(f.verify).toThrow('explicit yes/no route state');
    f.phone.VVS_PHONE_TEST_ROUTE_ACTIVE = 'no';
    f.phone.VVS_PHONE_TEST_EXPECTED_RULE_ID = 'not-a-rule';
    expect(f.verify).toThrow('dispatch rule');
    f.phone.VVS_PHONE_TEST_EXPECTED_RULE_ID = 'SDR_abcdef123';
    f.phone.VVS_PHONE_TEST_CALLED_NUMBER = '123';
    expect(f.verify).toThrow('phone number');
  });

  it('refuses a source browser event without verified cleanup', () => {
    const f = fixture();
    writeFileSync(f.stageState, JSON.stringify({
      version: 1, eventId: 'vvstest' + 'b'.repeat(24),
      status: 'created', start: '2026-11-24T22:00:00Z',
      end: '2026-11-24T23:15:00Z',
      createdAt: '', updatedAt: '',
    }));
    expect(f.verify).toThrow('not independently verified as cleaned');
  });

  it('refuses to reuse the same one-use ledger after any attempt', () => {
    const f = fixture();
    writeFileSync(f.phoneState, JSON.stringify({ used: true }));
    expect(f.verify).toThrow('fresh independent one-use');
  });

  it('only arms on an explicit private runtime switch', () => {
    const f = fixture();
    const settings = join(f.folder, 'arm.env');
    writeFileSync(settings, 'VVS_PHONE_TEST_PREPARED=yes\nVVS_PHONE_TEST_ROUTE_ACTIVE=no\n');
    expect(phoneTestArmed(settings)).toBe(false);
    writeFileSync(settings, 'VVS_PHONE_TEST_PREPARED=yes\nVVS_PHONE_TEST_ROUTE_ACTIVE=yes\n');
    expect(phoneTestArmed(settings)).toBe(true);
    writeFileSync(settings, 'VVS_PHONE_TEST_PREPARED=no\nVVS_PHONE_TEST_ROUTE_ACTIVE=yes\n');
    expect(phoneTestArmed(settings)).toBe(false);
  });
});
