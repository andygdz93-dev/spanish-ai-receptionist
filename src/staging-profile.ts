import { isAbsolute, relative, resolve } from 'node:path';
import { readProducerConfig } from './operational-producer.ts';

export type StagingProfile = {
  mode:'staging'; demoOnly:true; telemetryEnabled:boolean; outboxPath:string|null;
};
/**
 * Runtime guard: staging must be explicitly configured, cannot inherit real
 * Google booking credentials, and must never reuse an in-repository outbox.
 */
export function validateStagingProfile(
  env:NodeJS.ProcessEnv, projectRoot=process.cwd(),
): StagingProfile | null {
  if(env.VVS_RUNTIME_PROFILE !== 'staging') return null;
  if(env.DENTAL_DEMO_MODE !== 'yes' ||
    env.DENTAL_BOOKINGS_ENABLED!=='no') {
    throw new Error('Staging requires demo-only bookings and no real booking flag');
  }
  for(const key of ['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN']){
    if(env[key])throw new Error('Staging must not inherit Google booking credentials: '+key);
  }
  if(env.VVS_STAGING_CREDENTIALS_CONFIRMED !== 'yes') {
    throw new Error('Staging LiveKit/project credentials require explicit review');
  }
  if(env.HQ_TELEMETRY_PRODUCER_ENABLED !== 'yes' &&
    env.HQ_TELEMETRY_PRODUCER_ENABLED !== 'no') {
    throw new Error('Staging must explicitly enable or disable telemetry producer');
  }
  if(env.HQ_TELEMETRY_PRODUCER_ENABLED === 'no'){
    return {mode:'staging',demoOnly:true,telemetryEnabled:false,outboxPath:null};
  }
  if(!env.HQ_TELEMETRY_ENDPOINT)throw new Error('Staging requires an explicitly selected HQ telemetry endpoint');
  const config=readProducerConfig(env);
  if(!config)throw new Error('Staging telemetry is not configured');
  const receiver=new URL(config.endpoint);
  const receiverPort=Number(receiver.port);
  if(receiver.protocol!=='http:' || receiver.hostname!=='127.0.0.1' ||
      !Number.isInteger(receiverPort) || receiverPort<1024 ||
      receiverPort>65535 || receiverPort===8787 || receiverPort===8081) {
    throw new Error('Staging HQ receiver must use a dedicated local loopback port');
  }
  if(!env.HQ_TELEMETRY_OUTBOX_PATH ||
    !isAbsolute(env.HQ_TELEMETRY_OUTBOX_PATH)) {
    throw new Error('Staging outbox must use an absolute persistent path outside the project');
  }
  const folder=resolve(projectRoot),outbox=resolve(env.HQ_TELEMETRY_OUTBOX_PATH);
  const rel=relative(folder,outbox);
  if(!rel || (!rel.startsWith('..\\') && !rel.startsWith('../') && rel!=='..' &&
    !isAbsolute(rel))) {
    throw new Error('Staging outbox must not be under the Git project');
  }
  return {mode:'staging',demoOnly:true,telemetryEnabled:true,outboxPath:config.outboxPath};
}
