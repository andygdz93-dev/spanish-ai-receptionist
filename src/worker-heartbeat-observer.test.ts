import { describe, expect, it, vi } from 'vitest';
import { matchesExistingWorker, parseExistingWorkerTarget } from './worker-heartbeat-observer.ts';

const target = { pid: 98765, startedAtMs: 1795555154591 };
describe('observer of an existing worker without worker registration', () => {
  it('requires an explicit process identity and rejects invalid or self targets', () => {
    expect(
      parseExistingWorkerTarget(['--pid', '98765', '--started-at-ms', '1795555154591']),
    ).toEqual(target);
    for (const args of [
      [],
      ['--pid', '98765'],
      ['--pid', '0', '--started-at-ms', '1795555154591'],
      ['--pid', String(process.pid), '--started-at-ms', '1795555154591'],
    ]) {
      expect(() => parseExistingWorkerTarget(args)).toThrow();
    }
  });
  it('requires both the original Node process birth time and OS ownership of the health port', async () => {
    const started = vi.fn(async () => target.startedAtMs);
    const owns = vi.fn(async () => true);
    expect(
      await matchesExistingWorker(target, 8081, { readStartedAt: started, ownsPort: owns }),
    ).toBe(true);
    expect(started).toHaveBeenCalledWith(target.pid);
    expect(owns).toHaveBeenCalledWith(8081, target.pid);
    expect(
      await matchesExistingWorker(target, 8081, {
        readStartedAt: async () => null,
        ownsPort: owns,
      }),
    ).toBe(false);
    expect(
      await matchesExistingWorker(target, 8081, {
        readStartedAt: async () => target.startedAtMs + 1,
        ownsPort: owns,
      }),
    ).toBe(false);
    expect(
      await matchesExistingWorker(target, 8081, {
        readStartedAt: started,
        ownsPort: async () => false,
      }),
    ).toBe(false);
    expect(
      await matchesExistingWorker(target, 8081, {
        readStartedAt: async () => {
          throw Error('Unavailable');
        },
        ownsPort: owns,
      }),
    ).toBe(false);
  });
});
