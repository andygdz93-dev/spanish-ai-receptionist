import { validateStagingProfile } from './staging-profile.ts';

try {
  const status=validateStagingProfile(process.env);
  if(!status)throw new Error('VVS_RUNTIME_PROFILE=staging is required');
  console.log('Staging policy validated; telemetry enabled:',status.telemetryEnabled);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid staging configuration');
  process.exitCode=1;
}
