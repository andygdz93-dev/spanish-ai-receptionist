import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type StagingHealthTarget = {
  url: string;
  port: number;
  expectedPid: number;
};
export type ListenerInspector = (port: number) => Promise<number | null>;

/** Staging voice server uses the same dedicated native endpoint as its reporter. */
export function readStagingWorkerServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  cliArgs: string[] = process.argv.slice(2),
): { host: '127.0.0.1'; port: number } | null {
  if (env.VVS_RUNTIME_PROFILE !== 'staging') return null;
  if (cliArgs.some((arg) => /^--(?:url|api-key|api-secret|worker-token)(?:=|$)/.test(arg))) {
    throw new Error(
      'Staging worker forbids CLI overrides of the reviewed LiveKit endpoint and credentials',
    );
  }
  if (env.VVS_STAGING_CREDENTIALS_CONFIRMED !== 'yes') {
    throw new Error('Unapproved staging voice credentials');
  }
  const expected = env.STAGING_LIVEKIT_URL;
  const effective = env.LIVEKIT_URL;
  if (!expected || !effective || expected !== effective) {
    throw new Error(
      'Staging voice worker requires a separately reviewed matching LiveKit project URL',
    );
  }
  let project: URL;
  try {
    project = new URL(effective);
  } catch {
    throw new Error('Invalid staging LiveKit project URL');
  }
  if (
    project.protocol !== 'wss:' &&
    !(project.protocol === 'ws:' && project.hostname === '127.0.0.1')
  ) {
    throw new Error('Staging LiveKit project URL must use secure WebSocket transport');
  }
  return {
    host: '127.0.0.1',
    port: parseStagingNativeHealthURL(env.STAGING_NATIVE_HEALTH_URL ?? '').port,
  };
}

export function parseStagingNativeHealthURL(raw: string): { url: string; port: number } {
  if (!raw) throw new Error('Staging native health URL must be explicit');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid staging native health URL');
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    port === 8081 ||
    port === 8787
  ) {
    throw new Error('Staging native health requires dedicated loopback URL, not port 8081');
  }
  return { url: parsed.href, port };
}

/**
 * Explicit, dedicated staging endpoint. Never attribute port 8081 to staging.
 * This is a native worker probe, not a claim of phone-call readiness.
 */
export function readStagingHealthTarget(env: NodeJS.ProcessEnv = process.env): StagingHealthTarget {
  if (env.VVS_RUNTIME_PROFILE !== 'staging' || env.VVS_STAGING_CREDENTIALS_CONFIRMED !== 'yes') {
    throw new Error('Staging health inspection requires approved staging identity');
  }
  const { url, port } = parseStagingNativeHealthURL(env.STAGING_NATIVE_HEALTH_URL ?? '');
  const pidText = env.STAGING_NATIVE_HEALTH_EXPECTED_PID ?? '';
  if (!/^[1-9][0-9]{0,9}$/.test(pidText)) {
    throw new Error('Staging health requires an explicit expected worker PID');
  }
  const expectedPid = Number(pidText);
  if (!Number.isSafeInteger(expectedPid) || expectedPid === process.pid) {
    throw new Error('Staging native health PID must identify a separate worker process');
  }
  return { url, port, expectedPid };
}

/** Exact IPv4 loopback listener only; ambiguous or malformed ownership fails closed. */
export function parseWindowsListener(
  output: string,
  port: number,
  host = '127.0.0.1',
): number | null {
  const owners: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (
      fields.length !== 5 ||
      fields[0] !== 'TCP' ||
      fields[1] !== `${host}:${port}` ||
      fields[2] !== '0.0.0.0:0' ||
      fields[3] !== 'LISTENING'
    )
      continue;
    if (!/^[1-9][0-9]{0,9}$/.test(fields[4]!)) return null;
    const pid = Number(fields[4]);
    if (!Number.isSafeInteger(pid)) return null;
    owners.push(pid);
  }
  return owners.length === 1 ? owners[0]! : null;
}

/** Win32 listener ownership is checked before AND after the native probe. */
export async function inspectWindowsListener(port: number): Promise<number | null> {
  if (process.platform !== 'win32') {
    throw new Error('Windows listener ownership verification unavailable');
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Invalid staging health port');
  }
  try {
    // Avoid PowerShell/CIM startup, which can exceed the probe budget on Windows.
    const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const pid = parseWindowsListener(stdout, port);
    if (pid === null) return null;
    const processInfo = await execFileAsync(
      'tasklist.exe',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 3000 },
    );
    // Preserve the Node-process check as well as the exact OS listener PID check.
    const rows = processInfo.stdout.trim().split(/\r?\n/);
    return rows.length === 1 && new RegExp(`^"node\\.exe","${pid}",`, 'i').test(rows[0]!)
      ? pid
      : null;
  } catch {
    return null;
  }
}

export async function assertStagingListener(
  target: StagingHealthTarget,
  inspect: ListenerInspector = inspectWindowsListener,
): Promise<void> {
  if ((await inspect(target.port)) !== target.expectedPid) {
    throw new Error('Staging native health listener PID does not match the authorized worker');
  }
}
