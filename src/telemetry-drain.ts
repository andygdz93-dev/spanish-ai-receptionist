// Separate opt-in outbox retrier. No LiveKit imports, no calls, no calendar access.
import { OperationalTelemetryProducer, readProducerConfig } from './operational-producer.ts';
import { validateStagingProfile } from './staging-profile.ts';

export async function runTelemetryDrainer(
  options: { once?: boolean; intervalMs?: number } = {},
): Promise<void> {
  if(process.env.VVS_RUNTIME_PROFILE==='staging') {
    const profile=validateStagingProfile(process.env);
    if(!profile?.telemetryEnabled)throw new Error('Unapproved staging outbox drain');
  }
  const config=readProducerConfig();
  if(!config)throw new Error('Telemetry producer disabled; drainer not started');
  const producer=new OperationalTelemetryProducer(config);
  let running=true;
  const stop=()=>{running=false;};
  process.once('SIGTERM',stop);
  process.once('SIGINT',stop);
  try{
    do{
      const outcome=await producer.flushBatch();
      const counts=producer.outbox.summary();
      // Counts only; never print raw payloads, secrets, caller data, or room metadata.
      console.log('hq-telemetry-outbox',JSON.stringify({outcome,counts}));
      if(options.once || !running)break;
      await new Promise(resolve=>setTimeout(resolve,options.intervalMs ?? 5000));
    }while(running);
  }finally{
    producer.close();
    process.off('SIGTERM',stop);
    process.off('SIGINT',stop);
  }
}

if(process.argv[1]?.replaceAll('\\','/').endsWith('/telemetry-drain.ts')){
  runTelemetryDrainer({once:process.argv.includes('--once')}).catch(error=>{
    console.error(error instanceof Error ? error.message : 'Telemetry outbox failed');
    process.exitCode=1;
  });
}
