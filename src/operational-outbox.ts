import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type TelemetryKind = 'call_started' | 'call_completed' | 'call_failed';
export type TelemetryEvent = {
  version: 1;
  businessId: string;
  workerId: string;
  eventId: string;
  source: 'livekit';
  occurredAt: string;
  type: TelemetryKind;
  sessionId: string;
  jobId?: string;
  errorCode?: string;
};
type Status = 'queued' | 'leased' | 'delivered' | 'dead';
export type OutboxRow = {
  sequence: number;
  event_id: string;
  payload_json: string;
  attempts: number;
  lease_token: string | null;
  status: Status;
  next_attempt_ms: number;
};
export type OutboxSummary = {
  queued: number;
  leased: number;
  delivered: number;
  dead: number;
};

function eventIdentity(event: TelemetryEvent): void {
  const identity = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
  if (!identity.test(event.sessionId) || !identity.test(event.workerId) ||
      !/^[0-9a-f-]{36}$/i.test(event.eventId) ||
      !/^[0-9a-f-]{36}$/i.test(event.businessId) ||
      !Number.isFinite(Date.parse(event.occurredAt))) {
    throw new Error('Invalid operational event identity');
  }
  if (event.type === 'call_failed' && !/^[a-z][a-z0-9_]{0,63}$/.test(event.errorCode ?? '')) {
    throw new Error('Invalid operational error category');
  }
  if (event.type !== 'call_failed' && event.errorCode !== undefined) {
    throw new Error('Unexpected error category');
  }
}

export class DurableTelemetryOutbox {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path === ':memory:') {
      this.#db = new DatabaseSync(':memory:');
    } else {
      const filename = resolve(path);
      mkdirSync(dirname(filename), { recursive: true });
      this.#db = new DatabaseSync(filename, { timeout: 5000 });
      this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS outbox_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        business_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN
          ('call_started','call_completed','call_failed')),
        is_terminal INTEGER NOT NULL CHECK(is_terminal IN (0,1)),
        payload_json TEXT NOT NULL CHECK(length(payload_json) <= 8192),
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN
          ('queued','leased','delivered','dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_ms INTEGER NOT NULL,
        lease_until_ms INTEGER,
        lease_token TEXT,
        last_error_class TEXT,
        created_at_ms INTEGER NOT NULL,
        delivered_at_ms INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS unique_started_session
        ON outbox_events(business_id,session_id)
        WHERE is_terminal=0;
      CREATE UNIQUE INDEX IF NOT EXISTS unique_terminal_session
        ON outbox_events(business_id,session_id)
        WHERE is_terminal=1;
      CREATE INDEX IF NOT EXISTS due_outbox_events
        ON outbox_events(status,next_attempt_ms,sequence);
    `);
  }

  #transaction<T>(action: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Durable before any network request. SQLite WAL serializes concurrent processes. */
  enqueue(event: TelemetryEvent, now = Date.now()): 'queued' | 'duplicate' {
    eventIdentity(event);
    const payload = JSON.stringify(event);
    if (Buffer.byteLength(payload) > 8192) throw new Error('Operational event too large');
    return this.#transaction(() => {
      const existing = this.#db.prepare(
        'SELECT payload_json FROM outbox_events WHERE event_id=?'
      ).get(event.eventId) as { payload_json: string } | undefined;
      if (existing) {
        if (existing.payload_json !== payload) throw new Error('Event ID payload collision');
        return 'duplicate';
      }
      this.#db.prepare(`
        INSERT INTO outbox_events
        (event_id,business_id,session_id,event_type,is_terminal,payload_json,
         next_attempt_ms,created_at_ms)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(event.eventId,event.businessId,event.sessionId,event.type,
        event.type === 'call_started' ? 0 : 1,payload,now,now);
      return 'queued';
    });
  }

  /** Lease one event; downstream terminal events wait for successful start delivery. */
  lease(now = Date.now(), ttlMs = 15_000): OutboxRow | null {
    return this.#transaction(() => {
      const candidate = this.#db.prepare(`
        SELECT e.* FROM outbox_events e
        WHERE ((e.status='queued' AND e.next_attempt_ms<=?)
          OR (e.status='leased' AND e.lease_until_ms<=?))
          AND NOT EXISTS (
            SELECT 1 FROM outbox_events prior
            WHERE prior.business_id=e.business_id
              AND prior.session_id=e.session_id
              AND prior.sequence<e.sequence AND prior.status<>'delivered'
          )
        ORDER BY e.sequence LIMIT 1
      `).get(now, now) as OutboxRow | undefined;
      if (!candidate) return null;
      const token=randomUUID();
      this.#db.prepare(`
        UPDATE outbox_events SET status='leased',lease_token=?,
          lease_until_ms=?,attempts=attempts+1
        WHERE event_id=?
      `).run(token,now+ttlMs,candidate.event_id);
      return { ...candidate, lease_token:token, status:'leased',attempts:candidate.attempts+1 };
    });
  }

  delivered(row: OutboxRow, now = Date.now()): boolean {
    return this.#db.prepare(`
      UPDATE outbox_events SET status='delivered',delivered_at_ms=?,
        lease_until_ms=NULL,lease_token=NULL,last_error_class=NULL
      WHERE event_id=? AND status='leased' AND lease_token=?
    `).run(now,row.event_id,row.lease_token).changes === 1;
  }

  retry(row: OutboxRow, failure: 'transport' | 'server' | 'rate_limited', now = Date.now()): boolean {
    const base = Math.min(300_000, 1000 * 2 ** Math.min(9,row.attempts-1));
    const jitter = Number.parseInt(row.event_id.replaceAll('-','').slice(0,4),16) % 250;
    return this.#db.prepare(`
      UPDATE outbox_events SET status='queued',next_attempt_ms=?,
        lease_until_ms=NULL,lease_token=NULL,last_error_class=?
      WHERE event_id=? AND status='leased' AND lease_token=?
    `).run(now+base+jitter,failure,row.event_id,row.lease_token).changes === 1;
  }

  dead(row: OutboxRow, reason: 'rejected' | 'invalid_configuration'): boolean {
    return this.#db.prepare(`
      UPDATE outbox_events SET status='dead',last_error_class=?,
        lease_until_ms=NULL,lease_token=NULL
      WHERE event_id=? AND status='leased' AND lease_token=?
    `).run(reason,row.event_id,row.lease_token).changes === 1;
  }

  summary(): OutboxSummary {
    const counts: OutboxSummary = { queued:0, leased:0, delivered:0, dead:0 };
    for (const row of this.#db.prepare(
      'SELECT status,count(*) AS total FROM outbox_events GROUP BY status'
    ).all() as Array<{ status: Status; total: number }>) {
      counts[row.status]=row.total;
    }
    return counts;
  }

  events(): Array<Pick<OutboxRow,'event_id'|'status'|'attempts'|'next_attempt_ms'>> {
    return this.#db.prepare(`
      SELECT event_id,status,attempts,next_attempt_ms
      FROM outbox_events ORDER BY sequence
    `).all() as Array<Pick<OutboxRow,'event_id'|'status'|'attempts'|'next_attempt_ms'>>;
  }

  diagnostics(): {
    pending:number; retryAttempts:number; dead:number; blockedByDeadLetter:number;
    oldestPendingAt:string|null; lastDeliveredAt:string|null;
  } {
    const summary=this.#db.prepare(`
      SELECT
        sum(CASE WHEN status IN ('queued','leased') THEN 1 ELSE 0 END) AS pending,
        sum(CASE WHEN attempts>1 THEN attempts-1 ELSE 0 END) AS retry_attempts,
        sum(CASE WHEN status='dead' THEN 1 ELSE 0 END) AS dead,
        min(CASE WHEN status IN ('queued','leased') THEN created_at_ms END) AS oldest,
        max(delivered_at_ms) AS latest
      FROM outbox_events
    `).get() as {
      pending:number|null;retry_attempts:number|null;dead:number|null;
      oldest:number|null;latest:number|null;
    };
    const blocked=this.#db.prepare(`
      SELECT count(*) AS total FROM outbox_events event
      WHERE event.status IN ('queued','leased')
        AND EXISTS(SELECT 1 FROM outbox_events prior
          WHERE prior.business_id=event.business_id
            AND prior.session_id=event.session_id
            AND prior.sequence<event.sequence AND prior.status='dead')
    `).get() as {total:number};
    const toIso=(value:number|null)=>value===null?null:new Date(value).toISOString();
    return {
      pending:summary.pending??0,retryAttempts:summary.retry_attempts??0,
      dead:summary.dead??0,blockedByDeadLetter:blocked.total,
      oldestPendingAt:toIso(summary.oldest),lastDeliveredAt:toIso(summary.latest),
    };
  }

  close(): void { this.#db.close(); }
}
