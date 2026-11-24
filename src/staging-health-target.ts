import { execFileSync } from 'node:child_process';

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
): {host:'127.0.0.1';port:number} | null {
  if (env.VVS_RUNTIME_PROFILE !== 'staging') return null;
  if (cliArgs.some(arg => /^--(?:url|api-key|api-secret|worker-token)(?:=|$)/.test(arg))) {
    throw new Error('Staging worker forbids CLI overrides of the reviewed LiveKit endpoint and credentials');
  }
  if (env.VVS_STAGING_CREDENTIALS_CONFIRMED !== 'yes') {
    throw new Error('Unapproved staging voice credentials');
  }
  const expected = env.STAGING_LIVEKIT_URL;
  const effective = env.LIVEKIT_URL;
  if (!expected || !effective || expected !== effective) {
    throw new Error('Staging voice worker requires a separately reviewed matching LiveKit project URL');
  }
  let project: URL;
  try { project = new URL(effective); }
  catch { throw new Error('Invalid staging LiveKit project URL'); }
  if (project.protocol !== 'wss:' &&
      !(project.protocol === 'ws:' && project.hostname === '127.0.0.1')) {
    throw new Error('Staging LiveKit project URL must use secure WebSocket transport');
  }
  return {host:'127.0.0.1',port:parseStagingNativeHealthURL(
    env.STAGING_NATIVE_HEALTH_URL ?? '',
  ).port};
}

export function parseStagingNativeHealthURL(raw: string): {url:string;port:number} {
  if (!raw) throw new Error('Staging native health URL must be explicit');
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error('Invalid staging native health URL'); }
  const port = Number(parsed.port);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
      parsed.pathname !== '/' || parsed.search || parsed.hash ||
      parsed.username || parsed.password || !Number.isInteger(port) ||
      port < 1024 || port > 65535 || port === 8081 || port === 8787) {
    throw new Error('Staging native health requires dedicated loopback URL, not port 8081');
  }
  return { url: parsed.href, port };
}

/**
 * Explicit, dedicated staging endpoint. Never attribute port 8081 to staging.
 * This is a native worker probe, not a claim of phone-call readiness.
 */
export function readStagingHealthTarget(
  env: NodeJS.ProcessEnv = process.env,
): StagingHealthTarget {
  if (env.VVS_RUNTIME_PROFILE !== 'staging' ||
      env.VVS_STAGING_CREDENTIALS_CONFIRMED !== 'yes') {
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

/** Win32 listener ownership is checked before AND after the native probe. */
export async function inspectWindowsListener(port: number): Promise<number | null> {
  if (process.platform !== 'win32') {
    throw new Error('Windows listener ownership verification unavailable');
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Invalid staging health port');
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    `$entries=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue)`,
    'if($entries.Count -ne 1){exit 3}',
    '$worker=Get-Process -Id $entries[0].OwningProcess -ErrorAction Stop',
    "if($worker.ProcessName -ne 'node'){exit 4}",
    'Write-Output $worker.Id',
  ].join(';');
  let result: string;
  try {
    result = execFileSync('powershell.exe',[
      '-NoProfile','-NonInteractive','-Command',script,
    ],{encoding:'utf8',windowsHide:true,timeout:3000,stdio:['ignore','pipe','ignore']}).trim();
  } catch { return null; }
  return /^[1-9][0-9]{0,9}$/.test(result) ? Number(result) : null;
}

export async function assertStagingListener(
  target: StagingHealthTarget,
  inspect: ListenerInspector = inspectWindowsListener,
): Promise<void> {
  if (await inspect(target.port) !== target.expectedPid) {
    throw new Error('Staging native health listener PID does not match the authorized worker');
  }
}
