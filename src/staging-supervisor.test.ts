import { describe,expect,it } from 'vitest';
import { parseSupervisorArgs,runStagingSupervisor } from './staging-supervisor.ts';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

describe('manual staging supervisor (never starts children in tests)',()=>{
 it('defaults to validation-only',()=>{
  expect(parseSupervisorArgs([])).toEqual({run:false,component:'drainer'});
  expect(parseSupervisorArgs(['--validate','--monitor'])).toEqual({run:false,component:'monitor'});
 });
 it('refuses unsupported arguments and contradictory flags',()=>{
  expect(()=>parseSupervisorArgs(['--run','--validate'])).toThrow('Select run or validate');
  expect(()=>parseSupervisorArgs(['--run','--monitor','--drainer'])).toThrow('Select one');
  expect(()=>parseSupervisorArgs(['--install-service'])).toThrow('Unrecognized');
 });
 it('validation mode never inspects secrets or starts subprocesses',async()=>{
  const result=await runStagingSupervisor({run:false,component:'drainer'},{});
  expect(result).toBe('validated_only');
 });
 it('monitor mode refuses absent worker OS identity before any subprocess starts',async()=>{
  const env={
   VVS_RUNTIME_PROFILE:'staging',VVS_STAGING_CREDENTIALS_CONFIRMED:'yes',
   DENTAL_DEMO_MODE:'yes',DENTAL_BOOKINGS_ENABLED:'no',
   HQ_TELEMETRY_PRODUCER_ENABLED:'yes',HQ_TELEMETRY_BUSINESS_ID:randomUUID(),
   HQ_TELEMETRY_WORKER_ID:'isolated-worker',
   HQ_TELEMETRY_SIGNING_SECRET:'test-only-stage-'.padEnd(48,'x'),
   HQ_TELEMETRY_ENDPOINT:'http://127.0.0.1:18788/api/internal/telemetry',
   HQ_TELEMETRY_OUTBOX_PATH:resolve('C:/stage-private/events.sqlite'),
  };
  await expect(runStagingSupervisor({run:true,component:'monitor'},env,resolve('C:/projects/voice')))
   .rejects.toThrow('Staging native health URL must be explicit');
 });
 it('run mode requires approved staging before spawning any process',async()=>{
  await expect(runStagingSupervisor({run:true,component:'drainer'},{})).rejects.toThrow('Staging telemetry supervisor requires');
 });
});
