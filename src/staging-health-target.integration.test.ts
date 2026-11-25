import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectWindowsListener, readStagingHealthTarget } from './staging-health-target.ts';
import { reportTelemetryHealth } from './telemetry-health.ts';
import { ownsWorkerHealthPort } from './worker-heartbeat.ts';

describe.skipIf(process.platform !== 'win32')(
  'real Windows localhost OS-port ownership, with disposable Node health server',
  () => {
    it('identifies an isolated child PID, probes its native-shaped endpoint, and signs only that evidence', async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'vvs-staging-native-'));
      const child = spawn(
        process.execPath,
        [
          '-e',
          [
            "const http=require('node:http')",
            "const s=http.createServer((_req,res)=>{res.writeHead(200);res.end('ok')})",
            "s.listen(0,'127.0.0.1',()=>console.log(s.address().port))",
          ].join(';'),
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      try {
        const port = await new Promise<number>((resolve, reject) => {
          let output = '';
          const limit = setTimeout(
            () => reject(Error('Isolated health subprocess startup timed out')),
            6000,
          );
          child.stdout.on('data', (data: Buffer) => {
            output += String(data);
            if (!output.includes('\n')) return;
            clearTimeout(limit);
            const first = Number(output.trim().split(/\s+/)[0]);
            if (!Number.isInteger(first)) reject(Error('Missing child health port'));
            else resolve(first);
          });
          child.once('error', reject);
          child.once('exit', () => reject(Error('Disposable health child exited unexpectedly')));
        });
        expect(port).not.toBe(8081);
        const expectedPid = child.pid;
        expect(expectedPid).toBeTypeOf('number');
        const target = readStagingHealthTarget({
          VVS_RUNTIME_PROFILE: 'staging',
          VVS_STAGING_CREDENTIALS_CONFIRMED: 'yes',
          STAGING_NATIVE_HEALTH_URL: `http://127.0.0.1:${port}/`,
          STAGING_NATIVE_HEALTH_EXPECTED_PID: String(expectedPid),
        });
        expect(await inspectWindowsListener(port)).toBe(expectedPid);
        expect(await ownsWorkerHealthPort(port)).toBe(false);
        expect(await ownsWorkerHealthPort(port, expectedPid)).toBe(true);
        const cfg = {
          businessId: randomUUID(),
          workerId: 'os-local-test',
          secret: 'mock-os-key-'.padEnd(48, 'z'),
          endpoint: 'http://127.0.0.1:18788/api/internal/telemetry',
          outboxPath: join(scratch, 'queue.sqlite'),
        };
        let signed = 0;
        const report = await reportTelemetryHealth(cfg, {
          target,
          fetchImpl: async (url, init) => {
            if (url === target.url) return fetch(url, init);
            signed++;
            const item = JSON.parse(String(init?.body)) as {
              type: string;
              health: string;
              eventId: string;
            };
            expect(item).toMatchObject({ type: 'worker_heartbeat', health: 'healthy' });
            return Response.json({ status: 'accepted', eventId: item.eventId }, { status: 202 });
          },
        });
        expect(report).toEqual({ delivered: true, probe: 'healthy', receipt: 'accepted' });
        expect(signed).toBe(1);
      } finally {
        if (child.exitCode === null && !child.killed) {
          const stopped = once(child, 'exit');
          child.kill();
          await stopped;
        }
        rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      }
    }, 20000);
  },
);
