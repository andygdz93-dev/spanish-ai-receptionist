import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emitRegisteredWorkerHeartbeat,
  ownsWorkerHealthPort,
  startProductionWorkerHeartbeats,
} from './worker-heartbeat.ts';

const folders: string[] = [];
const secret = 'production-heartbeat-test-secret-'.padEnd(60, 'x');
function config() {
  const folder = mkdtempSync(join(tmpdir(), 'worker-heartbeat-'));
  folders.push(folder);
  return {
    businessId: randomUUID(),
    workerId: 'my-agent-test-worker',
    secret,
    endpoint: 'http://127.0.0.1:8787/api/internal/telemetry',
    outboxPath: join(folder, 'outbox.sqlite'),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  folders
    .splice(0)
    .forEach((folder) =>
      rmSync(folder, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
    );
});

describe('registered production worker heartbeat', () => {
  it('uses a 30-second cadence, prevents overlapping sends, and stops future work', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const cfg = config();
    let completeHealth!: (value: Response) => void;
    let pendingHealth = new Promise<Response>((resolve) => {
      completeHealth = resolve;
    });
    const requests: string[] = [];
    const stop = startProductionWorkerHeartbeats(
      {
        HQ_TELEMETRY_PRODUCER_ENABLED: 'yes',
        HQ_TELEMETRY_BUSINESS_ID: cfg.businessId,
        HQ_TELEMETRY_WORKER_ID: cfg.workerId,
        HQ_TELEMETRY_SIGNING_SECRET: secret,
        HQ_TELEMETRY_ENDPOINT: cfg.endpoint,
        HQ_TELEMETRY_OUTBOX_PATH: cfg.outboxPath,
      },
      {
        ownsHealthPort: async () => true,
        fetchImpl: async (url, init) => {
          requests.push(init?.method ?? '');
          if (init?.method === 'GET') return pendingHealth;
          const event = JSON.parse(String(init?.body)) as { eventId: string };
          return Response.json({ status: 'accepted', eventId: event.eventId }, { status: 202 });
        },
      },
    )!;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toEqual(['GET']);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toEqual(['GET']); // neither interval overlaps a slow probe
      completeHealth(new Response('', { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toEqual(['GET', 'POST']);
      pendingHealth = Promise.resolve(new Response('', { status: 200 }));
      await vi.advanceTimersByTimeAsync(29_999);
      expect(requests).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(requests).toEqual(['GET', 'POST', 'GET', 'POST']);
      stop();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(requests).toHaveLength(4);
    } finally {
      stop();
    }
  });
  it('cancels a pending probe on stop and removes its shutdown listeners', async () => {
    vi.useFakeTimers();
    const cfg = config();
    const initialListeners = process.listenerCount('SIGTERM');
    let completeHealth!: (response: Response) => void;
    let probeSignal: AbortSignal | null | undefined;
    const requests: string[] = [];
    const stop = startProductionWorkerHeartbeats(
      {
        HQ_TELEMETRY_PRODUCER_ENABLED: 'yes',
        HQ_TELEMETRY_BUSINESS_ID: cfg.businessId,
        HQ_TELEMETRY_WORKER_ID: cfg.workerId,
        HQ_TELEMETRY_SIGNING_SECRET: secret,
        HQ_TELEMETRY_ENDPOINT: cfg.endpoint,
        HQ_TELEMETRY_OUTBOX_PATH: cfg.outboxPath,
      },
      {
        ownsHealthPort: async () => true,
        fetchImpl: async (_url, init) => {
          requests.push(init?.method ?? '');
          probeSignal = init?.signal;
          return new Promise<Response>((resolve) => {
            completeHealth = resolve;
          });
        },
      },
    )!;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toEqual(['GET']);
      expect(process.listenerCount('SIGTERM')).toBe(initialListeners + 1);
      stop();
      expect(probeSignal?.aborted).toBe(true);
      completeHealth(new Response('', { status: 200 }));
      await vi.advanceTimersByTimeAsync(90_000);
      expect(requests).toEqual(['GET']);
      expect(process.listenerCount('SIGTERM')).toBe(initialListeners);
    } finally {
      stop();
    }
  });

  it.runIf(['win32', 'linux'].includes(process.platform))(
    'requires this process to own the native health listener',
    async () => {
      const server = createServer((_request, response) => response.end('ok'));
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as { port: number }).port;
      try {
        expect(await ownsWorkerHealthPort(port)).toBe(true);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      expect(await ownsWorkerHealthPort(port)).toBe(false);
    },
  );

  it('does not probe an unowned listener or sign after listener ownership changes', async () => {
    const cfg = config();
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    expect(
      await emitRegisteredWorkerHeartbeat(cfg, {
        ownsHealthPort: async () => false,
        fetchImpl,
      }),
    ).toBe('worker_not_healthy');
    expect(fetchImpl).not.toHaveBeenCalled();
    const owner = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(
      await emitRegisteredWorkerHeartbeat(cfg, {
        ownsHealthPort: owner,
        fetchImpl,
      }),
    ).toBe('worker_not_healthy');
    expect(fetchImpl).toHaveBeenCalledOnce(); // local health only; no HQ POST
  });
  it('does not contact HQ unless native worker health is HTTP 200', async () => {
    const cfg = config();
    const calls: string[] = [];
    expect(
      await emitRegisteredWorkerHeartbeat(cfg, {
        ownsHealthPort: async () => true,
        fetchImpl: async (url) => {
          calls.push(String(url));
          return new Response('', { status: 503 });
        },
      }),
    ).toBe('worker_not_healthy');
    expect(calls).toEqual(['http://127.0.0.1:8081/']);

    expect(
      await emitRegisteredWorkerHeartbeat(cfg, {
        ownsHealthPort: async () => true,
        fetchImpl: async () => {
          throw Error('connection refused');
        },
      }),
    ).toBe('health_unavailable');
  });

  it('sends a signed minimal healthy event with queue diagnostics after registration health', async () => {
    const cfg = config();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const now = () => Date.parse('2026-11-24T23:15:00.000Z');
    const result = await emitRegisteredWorkerHeartbeat(cfg, {
      ownsHealthPort: async () => true,
      now,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        if (calls.length === 1) return new Response('', { status: 200 });
        const event = JSON.parse(String(init?.body)) as { eventId: string };
        return Response.json({ status: 'accepted', eventId: event.eventId }, { status: 202 });
      },
    });
    expect(result).toBe('accepted');
    expect(calls.map((call) => call.url)).toEqual(['http://127.0.0.1:8081/', cfg.endpoint]);
    const request = calls[1]!.init!;
    const raw = String(request.body);
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body).toMatchObject({
      version: 1,
      type: 'worker_heartbeat',
      businessId: cfg.businessId,
      workerId: cfg.workerId,
      source: 'livekit',
      health: 'healthy',
      occurredAt: '2026-11-24T23:15:00.000Z',
      queue: { pending: 0, retryAttempts: 0, dead: 0, blockedByDeadLetter: 0 },
    });
    expect(Object.keys(body).sort()).toEqual([
      'businessId',
      'eventId',
      'health',
      'occurredAt',
      'queue',
      'source',
      'type',
      'version',
      'workerId',
    ]);
    expect(raw).not.toMatch(/transcript|phone|room|patient|booking/i);
    const headers = request.headers as Record<string, string>;
    expect(headers['x-hq-signature']).toBe(
      createHmac('sha256', secret)
        .update('v1\n' + headers['x-hq-timestamp'] + '\n' + headers['x-hq-nonce'] + '\n' + raw)
        .digest('hex'),
    );
  });

  it('requires an exact HQ receipt and stays disabled with telemetry off', async () => {
    const cfg = config();
    let calls = 0;
    expect(
      await emitRegisteredWorkerHeartbeat(cfg, {
        ownsHealthPort: async () => true,
        fetchImpl: async () => {
          calls++;
          return calls === 1
            ? new Response('', { status: 200 })
            : Response.json({ status: 'accepted', eventId: randomUUID() }, { status: 202 });
        },
      }),
    ).toBe('hq_rejected');
    expect(startProductionWorkerHeartbeats({ HQ_TELEMETRY_PRODUCER_ENABLED: 'no' })).toBeNull();
  });
});
