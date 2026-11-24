// Opt-in observer. Signed native health evidence, not proof of phone-call readiness.
import { randomBytes, randomUUID } from 'node:crypto';
import { DurableTelemetryOutbox } from './operational-outbox.ts';
import { readProducerConfig, signRequest } from './operational-producer.ts';
import { validateStagingProfile } from './staging-profile.ts';
import type { ProducerConfig } from './operational-producer.ts';
import {
  assertStagingListener, inspectWindowsListener, readStagingHealthTarget,
} from './staging-health-target.ts';
import type { ListenerInspector, StagingHealthTarget } from './staging-health-target.ts';

export type HealthReport = {
  delivered: boolean;
  probe: 'healthy' | 'unreachable';
  receipt: 'accepted' | 'rejected' | 'unavailable';
};

export async function reportTelemetryHealth(
  config: ProducerConfig,
  options: {
    target: StagingHealthTarget;
    inspectListener?: ListenerInspector;
    fetchImpl?: typeof fetch;
    now?: () => number;
  },
): Promise<HealthReport> {
  const fetchImpl = options.fetchImpl ?? fetch, now = options.now ?? Date.now;
  const target = options.target;
  // Never follow an implicit default or probe an existing worker's known 8081 port.
  const url = new URL(target.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      url.pathname !== '/' || url.search || url.hash ||
      url.username || url.password || url.port === '8081' ||
      Number(url.port) !== target.port ||
      !Number.isSafeInteger(target.expectedPid) || target.expectedPid <= 0 ||
      target.expectedPid === process.pid) {
    throw new Error('Only explicitly identified dedicated loopback worker probes are permitted');
  }
  const inspector = options.inspectListener ?? inspectWindowsListener;
  // Refuse to attribute a response to a worker whose OS listener identity is unknown.
  await assertStagingListener(target, inspector);
  let probe: 'healthy' | 'unreachable' = 'unreachable';
  try {
    const response = await fetchImpl(target.url, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(2000),
    });
    if (response.status === 200) probe = 'healthy';
  } catch { /* Native probe failed; never report it as healthy. */ }
  // Listener may have died/restarted while the health request was in flight.
  // Do not emit any signal if the process identity changed.
  await assertStagingListener(target, inspector);

  const outbox = new DurableTelemetryOutbox(config.outboxPath);
  let snapshot: ReturnType<DurableTelemetryOutbox['diagnostics']>;
  try { snapshot = outbox.diagnostics(); }
  finally { outbox.close(); }
  const event = {
    version: 1, type: 'worker_heartbeat', eventId: randomUUID(),
    businessId: config.businessId, workerId: config.workerId,
    source: 'livekit', occurredAt: new Date(now()).toISOString(),
    health: probe, queue: snapshot,
  };
  const raw = JSON.stringify(event);
  const nonce = randomBytes(16).toString('hex'), timestamp = String(now());
  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: {
        'content-type': 'application/json', 'x-hq-timestamp': timestamp,
        'x-hq-nonce': nonce, 'x-hq-signature': signRequest(config.secret,timestamp,nonce,raw),
      },
      body: raw,
    });
    if (response.status !== 202 && response.status !== 200) {
      return {delivered:false,probe,receipt:'rejected'};
    }
    const result = await response.json() as {status?:string;eventId?:string};
    if (result.eventId !== event.eventId ||
        !['accepted','duplicate'].includes(result.status ?? '')) {
      return {delivered:false,probe,receipt:'rejected'};
    }
    return {delivered:true,probe,receipt:'accepted'};
  } catch { return {delivered:false,probe,receipt:'unavailable'}; }
}

export async function runTelemetryHealthMonitor(
  opts: {once?:boolean;intervalMs?:number} = {},
): Promise<void> {
  const profile = validateStagingProfile(process.env);
  if (!profile?.telemetryEnabled) throw new Error('Staging health monitoring requires approved staging telemetry');
  const config = readProducerConfig();
  if (!config) throw new Error('Telemetry monitoring disabled');
  const target = readStagingHealthTarget();
  let running = true;
  const stop = () => { running = false; };
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    do {
      const result = await reportTelemetryHealth(config,{target});
      // No keys, session payloads, caller data or clinic identifiers in logs.
      console.log('hq-telemetry-probe',result.probe,result.receipt);
      if (opts.once || !running) break;
      await new Promise(resolveWait => setTimeout(resolveWait,opts.intervalMs ?? 30000));
    } while (running);
  } finally {
    process.off('SIGINT',stop); process.off('SIGTERM',stop);
  }
}
if (process.argv[1]?.replaceAll('\\','/').endsWith('/telemetry-health.ts')) {
  runTelemetryHealthMonitor({once:process.argv.includes('--once')}).catch(error=>{
    console.error(error instanceof Error ? error.message : 'Telemetry monitor failed');
    process.exitCode = 1;
  });
}
