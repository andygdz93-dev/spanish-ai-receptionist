[CmdletBinding()]
param(
  [ValidateSet('drainer','monitor')][string]$Component = 'drainer',
  [switch]$Run
)
$ErrorActionPreference = 'Stop'
$voiceProject = Split-Path -Parent $PSScriptRoot
$module = if ($Component -eq 'drainer') { 'src/telemetry-drain.ts' } else { 'src/telemetry-health.ts' }
if (-not (Test-Path -LiteralPath (Join-Path $voiceProject $module))) {
  throw 'Selected component does not exist.'
}
if (-not $Run) {
  Write-Output ('VALIDATED_CONFIG_ONLY component=' + $Component + '; no worker or service started')
  return
}
if ($env:VVS_RUNTIME_PROFILE -ne 'staging') {
  throw 'Refusing to start: VVS_RUNTIME_PROFILE must be staging'
}
Push-Location -LiteralPath $voiceProject
try {
  & node src/staging-preflight.ts
  if ($LASTEXITCODE -ne 0) { throw 'Staging preflight refused startup' }
  if ($env:HQ_TELEMETRY_PRODUCER_ENABLED -ne 'yes') {
    throw 'Refusing to launch disabled telemetry producer'
  }
  Write-Output ('MANUAL_STAGING_SUPERVISOR_STARTED component=' + $Component)
  # Intentionally not installed as a Windows service or scheduled task.
  # Each child runs one finite iteration; failures resume after the bounded sleep.
  while ($true) {
    try {
      & node $module --once
      $exitCode = $LASTEXITCODE
      if ($exitCode -ne 0) {
        Write-Warning ('Telemetry component exited with non-zero status: ' + $exitCode)
      }
    } catch {
      Write-Warning 'Telemetry component could not be executed; retrying without event payload logging'
    }
    $delay = if ($Component -eq 'monitor') { 30 } else { 5 }
    Start-Sleep -Seconds $delay
  }
} finally {
  Pop-Location
}
