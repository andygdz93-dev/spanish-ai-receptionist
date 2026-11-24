import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DurableTelemetryOutbox } from './operational-outbox.ts';
import type { TelemetryEvent } from './operational-outbox.ts';

export type ProducerConfig = {
  businessId: string;
  workerId: string;
  secret: string;
  endpoint: string;
  outboxPath: string;
};

export function readProducerConfig(env: NodeJS.ProcessEnv = process.env): ProducerConfig | null {
  if (env.HQ_TELEMETRY_PRODUCER_ENABLED !== 'yes') return null;
  const businessId=env.HQ_TELEMETRY_BUSINESS_ID ?? '';
  const workerId=env.HQ_TELEMETRY_WORKER_ID ?? '';
  const secret=env.HQ_TELEMETRY_SIGNING_SECRET ?? '';
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(businessId) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(workerId) ||
      Buffer.byteLength(secret) < 32) {
    throw new Error('Operational telemetry requires a valid business ID, worker ID and 32-byte secret');
  }
  const endpoint=new URL(env.HQ_TELEMETRY_ENDPOINT ?? 'http://127.0.0.1:8787/api/internal/telemetry');
  if (!((endpoint.protocol==='http:' && endpoint.hostname==='127.0.0.1') || endpoint.protocol==='https:') ||
      endpoint.pathname!=='/api/internal/telemetry' || endpoint.search || endpoint.hash ||
      endpoint.username || endpoint.password) {
    throw new Error('Operational telemetry requires HTTPS or loopback HQ internal endpoint');
  }
  const outboxPath=resolve(env.HQ_TELEMETRY_OUTBOX_PATH ?? '.telemetry-outbox.sqlite');
  if (!outboxPath.endsWith('.sqlite')) throw new Error('Outbox path must have .sqlite extension');
  return { businessId, workerId, secret, endpoint:endpoint.href, outboxPath };
}

export function hashedSessionId(jobId: string): string {
  if (typeof jobId !== 'string' || !jobId || jobId.length>1024) {
    throw new Error('LiveKit job identifier is unavailable');
  }
  return 'lk-'+createHash('sha256').update(jobId).digest('hex').slice(0,40);
}

export function createLifecycleEvent(
  config: ProducerConfig, jobId: string,
  type: TelemetryEvent['type'], now = Date.now(),
  errorCode?: 'agent_session_error',
): TelemetryEvent {
  const occurredAt=new Date(now).toISOString();
  const base: TelemetryEvent = {
    version:1,
    businessId:config.businessId,
    workerId:config.workerId,
    eventId:randomUUID(),
    source:'livekit',
    occurredAt,
    type,
    sessionId:hashedSessionId(jobId),
  };
  // Do not send room names, participant identifiers, SIP metadata, phone numbers or transcripts.
  if (type==='call_failed') base.errorCode=errorCode ?? 'agent_session_error';
  return base;
}

export function signRequest(secret: string, timestamp: string, nonce: string, raw: string): string {
  return createHmac('sha256',secret).update('v1\n'+timestamp+'\n'+nonce+'\n'+raw).digest('hex');
}

export class OperationalTelemetryProducer {
  readonly outbox: DurableTelemetryOutbox;
  readonly #config: ProducerConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(
    config: ProducerConfig,
    options: { fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {
    this.#config=config;
    this.#fetch=options.fetchImpl ?? fetch;
    this.#now=options.now ?? Date.now;
    this.outbox=new DurableTelemetryOutbox(config.outboxPath);
  }

  enqueue(jobId: string, type: TelemetryEvent['type'], errorCode?: 'agent_session_error'): TelemetryEvent {
    const event=createLifecycleEvent(this.#config,jobId,type,this.#now(),errorCode);
    this.outbox.enqueue(event,this.#now());
    return event;
  }

  async flushOnce(): Promise<'idle' | 'delivered' | 'retry' | 'dead'> {
    const row=this.outbox.lease(this.#now());
    if(!row)return 'idle';
    const nonce=randomBytes(16).toString('hex');
    const stamp=String(this.#now());
    const signature=signRequest(this.#config.secret,stamp,nonce,row.payload_json);
    try{
      const response=await this.#fetch(this.#config.endpoint,{
        method:'POST',
        redirect:'error',
        headers:{
          'content-type':'application/json',
          'x-hq-timestamp':stamp,'x-hq-nonce':nonce,'x-hq-signature':signature,
        },
        body:row.payload_json,
        signal:AbortSignal.timeout(2500),
      });
      if(response.status===202 || response.status===200){
        // HTTP success by itself is not proof that HQ persisted this exact event.
        // A captive portal, reverse proxy or incorrect service may also return 200.
        let receipt: unknown;
        try { receipt=await response.json(); } catch { receipt=null; }
        const accepted = typeof receipt==='object' && receipt!==null &&
          'eventId' in receipt && 'status' in receipt &&
          receipt.eventId===row.event_id &&
          (receipt.status==='accepted' || receipt.status==='duplicate');
        if(!accepted){
          this.outbox.retry(row,'server',this.#now());
          return 'retry';
        }
        if(!this.outbox.delivered(row,this.#now())) return 'retry';
        return 'delivered';
      }
      if(response.status===408 || response.status===429 || response.status>=500){
        this.outbox.retry(row,response.status===429?'rate_limited':'server',this.#now());
        return 'retry';
      }
      // Permanent errors are preserved in a visible dead-letter row, never silently dropped.
      this.outbox.dead(row,response.status===401 || response.status===403
        ? 'invalid_configuration' : 'rejected');
      return 'dead';
    }catch{
      this.outbox.retry(row,'transport',this.#now());
      return 'retry';
    }
  }

  async flushBatch(maxEvents = 20): Promise<{delivered:number;retried:number;dead:number}> {
    const result={delivered:0,retried:0,dead:0};
    for(let i=0;i<maxEvents;i++){
      const state=await this.flushOnce();
      if(state==='idle')break;
      if(state==='delivered')result.delivered++;
      if(state==='retry')result.retried++;
      if(state==='dead')result.dead++;
    }
    return result;
  }

  close(): void { this.outbox.close(); }
}
