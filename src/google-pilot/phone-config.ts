// Reuse the proven one-event pilot without connecting its isolated worker to production.
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { DateTime } from 'luxon';
import { readPilotConfig, readPilotState, type PilotConfig } from './pilot.ts';

export const PHONE_TEST_AGENT_NAME = 'vvs-google-phone-test';
export const PHONE_TEST_ENV_PATH = '.env.google-phone-test.local';

export type PhoneTestConfig = {
  pilot: PilotConfig;
  expectedRuleId: string;
  expectedCalledNumber: string;
};

export function readPhoneTestConfig(
  phoneEnv: NodeJS.ProcessEnv,
  isolatedEnv: NodeJS.ProcessEnv,
  originalEnv: NodeJS.ProcessEnv,
  root = process.cwd(),
  now = DateTime.now(),
): PhoneTestConfig {
  if (phoneEnv.VVS_PHONE_TEST_PREPARED !== 'yes')
    throw new Error('Phone test was not prepared and explicitly reviewed');
  // LiveKit imports this module again inside each per-call job subprocess.
  // Requiring 'no' here prevented every call from starting once routing was armed.
  // Actual per-call authorization remains enforced by phoneTestArmed() in entry/tools.
  if (phoneEnv.VVS_PHONE_TEST_ROUTE_ACTIVE !== 'yes' &&
      phoneEnv.VVS_PHONE_TEST_ROUTE_ACTIVE !== 'no')
    throw new Error('Phone test requires an explicit yes/no route state');
  const ruleId = phoneEnv.VVS_PHONE_TEST_EXPECTED_RULE_ID ?? '';
  const calledNumber = phoneEnv.VVS_PHONE_TEST_CALLED_NUMBER ?? '';
  if (!/^SDR_[A-Za-z0-9]+$/.test(ruleId))
    throw new Error('Phone test requires the reviewed original dispatch rule ID');
  if (!/^\+[1-9]\d{7,14}$/.test(calledNumber))
    throw new Error('Phone test requires the reviewed existing phone number');
  if (isolatedEnv.VVS_PILOT_BROWSER_ROUTE_VERIFIED !== 'yes' ||
      isolatedEnv.VVS_PILOT_CALL_ROUTE_VERIFIED !== 'no')
    throw new Error('The original isolated browser pilot profile changed');
  const previous = readPilotState(isolatedEnv.VVS_PILOT_STATE_PATH ?? '');
  if (previous?.status !== 'cleaned' || !previous.writeVerifiedAt || !previous.cleanupVerifiedAt)
    throw new Error('Previous browser test is not independently verified as cleaned');
  const pilot = readPilotConfig({
    ...isolatedEnv,
    VVS_PILOT_TEST_DATE: phoneEnv.VVS_PHONE_TEST_DATE,
    VVS_PILOT_TEST_TIME: phoneEnv.VVS_PHONE_TEST_TIME,
    VVS_PILOT_STATE_PATH: phoneEnv.VVS_PHONE_TEST_STATE_PATH,
  }, originalEnv, root, now);
  if (pilot.statePath === isolatedEnv.VVS_PILOT_STATE_PATH || existsSync(pilot.statePath))
    throw new Error('Phone test requires a fresh independent one-use audit ledger');
  const livekitUrl = originalEnv.LIVEKIT_URL ?? '';
  const livekitKey = originalEnv.LIVEKIT_API_KEY ?? '';
  const livekitSecret = originalEnv.LIVEKIT_API_SECRET ?? '';
  if (!/^wss:\/\/[A-Za-z0-9.-]+\.livekit\.cloud\/?$/.test(livekitUrl) ||
      !livekitKey || !livekitSecret ||
      livekitUrl === pilot.livekitUrl || livekitKey === pilot.livekitKey)
    throw new Error('Original project credentials invalid or not distinct');
  const healthPort = Number(phoneEnv.VVS_PHONE_TEST_HEALTH_PORT);
  if (!Number.isInteger(healthPort) || healthPort < 1024 || healthPort > 65535 ||
      [8081, 18082].includes(healthPort))
    throw new Error('Phone test health port must be separate');
  return {
    pilot: { ...pilot, livekitUrl, livekitKey, livekitSecret, healthPort },
    expectedRuleId: ruleId,
    expectedCalledNumber: calledNumber,
  };
}

// Called at call dispatch and at each booking tool invocation, not merely worker startup.
export function phoneTestArmed(path = PHONE_TEST_ENV_PATH): boolean {
  try {
    const settings = parse(readFileSync(path, 'utf8'));
    return settings.VVS_PHONE_TEST_PREPARED === 'yes' &&
      settings.VVS_PHONE_TEST_ROUTE_ACTIVE === 'yes';
  } catch {
    return false;
  }
}
