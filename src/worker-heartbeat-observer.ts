// Optional monitor for an identified, already-running Windows worker.
// No LiveKit SDK import, registration, room connection, or calendar action.
import dotenv from 'dotenv';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ownsWorkerHealthPort, startProductionWorkerHeartbeats } from './worker-heartbeat.ts';

const execFileAsync = promisify(execFile);
export type ExistingWorkerTarget = { pid: number; startedAtMs: number };

export function parseExistingWorkerTarget(args: string[]): ExistingWorkerTarget {
  if (
    args.length !== 4 ||
    args[0] !== '--pid' ||
    args[2] !== '--started-at-ms' ||
    !/^[1-9][0-9]{0,9}$/.test(args[1] ?? '') ||
    !/^[1-9][0-9]{12}$/.test(args[3] ?? '')
  ) {
    throw Error('Explicit worker PID and process start time are required');
  }
  const pid = Number(args[1]),
    startedAtMs = Number(args[3]);
  if (!Number.isSafeInteger(pid) || pid === process.pid || !Number.isSafeInteger(startedAtMs)) {
    throw Error('Invalid existing worker identity');
  }
  return { pid, startedAtMs };
}

async function readNodeProcessStart(pid: number): Promise<number | null> {
  if (process.platform !== 'win32') return null;
  try {
    // PID is validated before interpolation. Output contains only process birth time.
    const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; if($p.ProcessName -ne 'node'){exit 4}; ([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`;
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 3000 },
    );
    return /^[1-9][0-9]{12}$/.test(stdout.trim()) ? Number(stdout.trim()) : null;
  } catch {
    return null;
  }
}

export async function matchesExistingWorker(
  target: ExistingWorkerTarget,
  port: number,
  options: {
    readStartedAt?: (pid: number) => Promise<number | null>;
    ownsPort?: (port: number, pid: number) => Promise<boolean>;
  } = {},
): Promise<boolean> {
  if (
    !Number.isSafeInteger(target.pid) ||
    target.pid <= 0 ||
    target.pid === process.pid ||
    !Number.isSafeInteger(target.startedAtMs) ||
    target.startedAtMs <= 0
  )
    return false;
  try {
    const [startedAt, ownsPort] = await Promise.all([
      (options.readStartedAt ?? readNodeProcessStart)(target.pid),
      (options.ownsPort ?? ownsWorkerHealthPort)(port, target.pid),
    ]);
    return startedAt === target.startedAtMs && ownsPort;
  } catch {
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'win32')
      throw Error('Existing worker observer requires Windows process identity checks');
    if (process.env.VVS_RUNTIME_PROFILE === 'staging')
      throw Error('Use the dedicated staging monitor for staging');
    dotenv.config({ path: '.env.local', quiet: true });
    const target = parseExistingWorkerTarget(process.argv.slice(2));
    if (!(await matchesExistingWorker(target, 8081)))
      throw Error('Existing worker process identity does not match');
    const stop = startProductionWorkerHeartbeats(process.env, {
      ownsHealthPort: (port) => matchesExistingWorker(target, port),
    });
    if (!stop) throw Error('HQ telemetry is disabled');
    console.log('hq-worker-observer started; existing process only');
    // Keep the observer alive independently of the worker's event loop.
    const lifetime = setInterval(() => {}, 60_000);
    const exit = () => {
      clearInterval(lifetime);
      stop();
    };
    process.once('SIGINT', exit);
    process.once('SIGTERM', exit);
  } catch {
    console.error('hq-worker-observer unavailable; no worker started');
    process.exitCode = 1;
  }
}
