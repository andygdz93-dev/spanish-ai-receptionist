import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const runner = fileURLToPath(new URL('../scripts/livekit-gemma-eval.mjs', import.meta.url));
const baseEnv = {
  ...process.env,
  LIVEKIT_URL: '',
  LIVEKIT_API_KEY: '',
  LIVEKIT_API_SECRET: '',
  LIVEKIT_TEST_CAP_VERIFIED: '',
};

function run(args: string[], env = baseEnv) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
}

describe('LiveKit configured-model integration safety gates', () => {
  it('reports missing credentials without exposing secrets or issuing a request', () => {
    const result = run(['--preflight']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const status = JSON.parse(result.stdout);
    expect(status.model).toBe('google/gemma-4-31b-it');
    expect(status.missing_credential_names).toEqual([
      'LIVEKIT_URL',
      'LIVEKIT_API_KEY',
      'LIVEKIT_API_SECRET',
    ]);
    expect(status.provider_spending_cap_verified).toBe(false);
    expect(status.planned_turns).toBe(8);
  });

  it('fails closed without credentials or a provider spending-cap check', () => {
    const result = run(['--run']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('BLOCKED');
    expect(result.stdout).toBe('');
  });

  it('does not expose credential values and blocks inference when billing verification is absent', () => {
    const sentinel = 'DO_NOT_PRINT_IN_LOGS_12345';
    const env = {
      ...baseEnv,
      LIVEKIT_URL: 'wss://test-project.livekit.cloud',
      LIVEKIT_API_KEY: sentinel,
      LIVEKIT_API_SECRET: sentinel,
    };
    const result = run(['--run'], env);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('provider_spending_cap_verified');
    expect(result.stderr).not.toContain(sentinel);
    expect(result.stdout).not.toContain(sentinel);
  });
});
