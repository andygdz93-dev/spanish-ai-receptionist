import type { JobContext } from '@livekit/agents';
import { OperationalTelemetryProducer, readProducerConfig } from './operational-producer.ts';

type JobContextForTelemetry = Pick<JobContext, 'job' | 'addShutdownCallback'>;

/**
 * A job records a room session, not proof of an inbound SIP call.
 * Off by default. No audio, participant metadata, transcript, patient or booking data.
 */
export function attachOperationalLifecycle(
  ctx: JobContextForTelemetry,
): { fail: () => void } | null {
  const config=readProducerConfig();
  if(!config)return null;
  const jobId=ctx.job?.id;
  if(!jobId) throw new Error('Operational telemetry needs a trusted LiveKit job ID');
  const producer=new OperationalTelemetryProducer(config);
  let ended=false;
  // Serialize background and shutdown sends. Close only after in-flight work settles.
  let inFlight: Promise<void> | null = null;
  const flush=(): Promise<void> => {
    if(inFlight)return inFlight;
    const pending=producer.flushBatch(4).then(()=>{}).catch(()=>{
      /* Durable outbox keeps all unacknowledged events. */
    }).finally(()=>{ if(inFlight===pending)inFlight=null; });
    inFlight=pending;
    return pending;
  };
  try {
    producer.enqueue(jobId,'call_started');
  }catch{
    // Telemetry must not interrupt receptionist service. No terminal event without a start.
    producer.close();
    return null;
  }
  const timer=setInterval(()=>{ void flush(); },5000);
  timer.unref();
  ctx.addShutdownCallback(async()=>{
    clearInterval(timer);
    if(!ended){
      ended=true;
      try{producer.enqueue(jobId,'call_completed');}catch{ /* outbox remains for inspection */ }
    }
    await flush();
    // In case an earlier in-flight batch finished before terminal enqueue.
    await flush();
    producer.close();
  });
  void flush();
  return {
    fail:()=>{
      if(ended)return;
      ended=true;
      try{producer.enqueue(jobId,'call_failed','agent_session_error');}
      catch{ /* Failure remains locally classified, never sent as patient text. */ }
      void flush();
    },
  };
}
