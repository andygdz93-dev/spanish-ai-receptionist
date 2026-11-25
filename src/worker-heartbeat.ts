// Production worker heartbeat. The native LiveKit health route is the registration gate.
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { DurableTelemetryOutbox } from './operational-outbox.ts';
import { readProducerConfig, signRequest } from './operational-producer.ts';
import type { ProducerConfig } from './operational-producer.ts';
import { parseWindowsListener } from './staging-health-target.ts';

const DEFAULT_INTERVAL_MS = 30_000;
const LIVEKIT_HEALTH_URL = 'http://127.0.0.1:8081/';
const execFileAsync = promisify(execFile);

export type WorkerHeartbeatResult =
  | 'accepted'
  | 'worker_not_healthy'
  | 'health_unavailable'
  | 'stopped'
  | 'hq_rejected'
  | 'hq_unavailable';

type HeartbeatOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  healthUrl?: string;
  ownsHealthPort?: (port: number) => Promise<boolean>;
  signal?: AbortSignal;
};

/** Attribute native health to this process, including before its server starts. */
export async function ownsWorkerHealthPort(
  port: number,
  expectedPid = process.pid,
): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) return false;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const rows = stdout.split(/\r?\n/).filter((line) => {
        const fields = line.trim().split(/\s+/);
        return (
          fields[0] === 'TCP' &&
          fields[3] === 'LISTENING' &&
          [`127.0.0.1:${port}`, `0.0.0.0:${port}`].includes(fields[1] ?? '')
        );
      });
      return (
        rows.length === 1 &&
        ['127.0.0.1', '0.0.0.0'].some(
          (host) => parseWindowsListener(rows[0]!, port, host) === expectedPid,
        )
      );
    }
    if (process.platform === 'linux') {
      if (expectedPid !== process.pid) return false;
      const rows = (await readFile('/proc/net/tcp', 'utf8')).trim().split('\n').slice(1);
      const sockets = new Set(
        rows.flatMap((row) => {
          const fields = row.trim().split(/\s+/);
          const address = fields[1]?.split(':');
          return fields[3] === '0A' &&
            address &&
            ['00000000', '0100007F'].includes(address[0]!) &&
            Number.parseInt(address[1]!, 16) === port
            ? [fields[9]!]
            : [];
        }),
      );
      const fds = await readdir('/proc/self/fd');
      for (const fd of fds) {
        try {
          const target = await readlink('/proc/self/fd/' + fd);
          const match = /^socket:\[(\d+)\]$/.exec(target);
          if (match && sockets.has(match[1]!)) return true;
        } catch {
          /* File descriptors can close while being inspected. */
        }
      }
    }
  } catch {
    /* Missing OS evidence must never become a healthy claim. */
  }
  return false;
}

function requestSignal(timeout: number, signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function assertLocalHealthUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error('Worker heartbeat requires the native loopback health endpoint');
  }
  return url.href;
}

/**
 * Emit only after LiveKit's native worker health route reports HTTP 200. In the
 * SDK this requires an open, registered worker connection and a live inference
 * process. No room, caller, transcript, phone, patient, or booking data is sent.
 */
export async function emitRegisteredWorkerHeartbeat(
  config: ProducerConfig,
  options: HeartbeatOptions = {},
): Promise<WorkerHeartbeatResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const healthUrl = assertLocalHealthUrl(options.healthUrl ?? LIVEKIT_HEALTH_URL);
  const port = Number(new URL(healthUrl).port || 80);
  const ownsHealthPort = options.ownsHealthPort ?? ownsWorkerHealthPort;
  if (options.signal?.aborted) return 'stopped';
  if (!(await ownsHealthPort(port))) return 'worker_not_healthy';
  if (options.signal?.aborted) return 'stopped';
  let health: Response;
  try {
    health = await fetchImpl(healthUrl, {
      method: 'GET',
      redirect: 'error',
      signal: requestSignal(2000, options.signal),
    });
  } catch {
    return options.signal?.aborted ? 'stopped' : 'health_unavailable';
  }
  if (options.signal?.aborted) return 'stopped';
  if (health.status !== 200) return 'worker_not_healthy';
  if (!(await ownsHealthPort(port))) return 'worker_not_healthy';
  if (options.signal?.aborted) return 'stopped';

  const outbox = new DurableTelemetryOutbox(config.outboxPath);
  let queue: ReturnType<DurableTelemetryOutbox['diagnostics']>;
  try {
    queue = outbox.diagnostics();
  } finally {
    outbox.close();
  }
  const event = {
    version: 1,
    type: 'worker_heartbeat',
    eventId: randomUUID(),
    businessId: config.businessId,
    workerId: config.workerId,
    source: 'livekit',
    occurredAt: new Date(now()).toISOString(),
    health: 'healthy',
    queue,
  } as const;
  const raw = JSON.stringify(event);
  const nonce = randomBytes(16).toString('hex');
  const timestamp = String(now());
  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: requestSignal(3000, options.signal),
      headers: {
        'content-type': 'application/json',
        'x-hq-timestamp': timestamp,
        'x-hq-nonce': nonce,
        'x-hq-signature': signRequest(config.secret, timestamp, nonce, raw),
      },
      body: raw,
    });
    if (response.status !== 202 && response.status !== 200) return 'hq_rejected';
    let receipt: unknown;
    try {
      receipt = await response.json();
    } catch {
      receipt = null;
    }
    const accepted =
      typeof receipt === 'object' &&
      receipt !== null &&
      'eventId' in receipt &&
      'status' in receipt &&
      receipt.eventId === event.eventId &&
      (receipt.status === 'accepted' || receipt.status === 'duplicate');
    return accepted ? 'accepted' : 'hq_rejected';
  } catch {
    return options.signal?.aborted ? 'stopped' : 'hq_unavailable';
  }
}

export function startProductionWorkerHeartbeats(
  env: NodeJS.ProcessEnv = process.env,
  options: HeartbeatOptions & { intervalMs?: number } = {},
): (() => void) | null {
  const config = readProducerConfig(env);
  if (!config) return null;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) {
    throw new Error('Worker heartbeat interval must be at least one second');
  }
  let stopped = false;
  let inFlight = false;
  const controller = new AbortController();
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const result = await emitRegisteredWorkerHeartbeat(config, {
        ...options,
        signal: controller.signal,
      });
      if (!stopped) console.log('hq-worker-heartbeat', result);
    } catch {
      if (!stopped) console.warn('hq-worker-heartbeat unavailable');
    } finally {
      inFlight = false;
    }
  };
  void tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    controller.abort();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return stop;
}
