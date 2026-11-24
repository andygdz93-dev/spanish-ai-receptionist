import { describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { validateStagingProfile } from './staging-profile.ts';

const root=resolve('C:/Projects/voice');
const safe={
 VVS_RUNTIME_PROFILE:'staging',
 VVS_STAGING_CREDENTIALS_CONFIRMED:'yes',
 DENTAL_DEMO_MODE:'yes',
 DENTAL_BOOKINGS_ENABLED:'no',
 HQ_TELEMETRY_PRODUCER_ENABLED:'no',
};
describe('explicit voice staging fail-closed configuration',()=>{
 it('preserves normal development behavior',()=>{
  expect(validateStagingProfile({},root)).toBeNull();
 });
 it('requires explicit staging credential review and prevents real bookings',()=>{
  expect(()=>validateStagingProfile({...safe,VVS_STAGING_CREDENTIALS_CONFIRMED:'no'},root)).toThrow('explicit review');
  expect(()=>validateStagingProfile({...safe,DENTAL_DEMO_MODE:'no'},root)).toThrow('demo-only');
  expect(()=>validateStagingProfile({...safe,DENTAL_BOOKINGS_ENABLED:'yes'},root)).toThrow('demo-only');
  expect(()=>validateStagingProfile({...safe,GOOGLE_REFRESH_TOKEN:'synthetic'},root)).toThrow('Google booking credentials');
 });
 it('accepts disabled telemetry without creating a database',()=>{
  expect(validateStagingProfile(safe,root)).toMatchObject({
   mode:'staging',demoOnly:true,telemetryEnabled:false,outboxPath:null
  });
 });
 it('requires a private absolute outbox path and safe endpoint when telemetry enabled',()=>{
  const env={
   ...safe,HQ_TELEMETRY_PRODUCER_ENABLED:'yes',
   HQ_TELEMETRY_BUSINESS_ID:randomUUID(),
   HQ_TELEMETRY_WORKER_ID:'stage-worker-1',
   HQ_TELEMETRY_SIGNING_SECRET:'synthetic-test-key-'.padEnd(50,'x'),
   HQ_TELEMETRY_ENDPOINT:'http://127.0.0.1:18788/api/internal/telemetry',
  };
  expect(()=>validateStagingProfile(env,root)).toThrow('absolute persistent path');
  expect(()=>validateStagingProfile({...env,HQ_TELEMETRY_OUTBOX_PATH:resolve(root,'private.sqlite')},root)).toThrow('under the Git project');
  expect(validateStagingProfile({
   ...env,HQ_TELEMETRY_OUTBOX_PATH:resolve('C:/vvs-staging/private.sqlite')
  },root)?.telemetryEnabled).toBe(true);
  expect(()=>validateStagingProfile({...env,HQ_TELEMETRY_ENDPOINT:'http://127.0.0.1:8787/api/internal/telemetry',
   HQ_TELEMETRY_OUTBOX_PATH:resolve('C:/vvs-staging/private.sqlite')},root)).toThrow('dedicated local loopback');
  expect(()=>validateStagingProfile({...env,HQ_TELEMETRY_ENDPOINT:'http://example.com/api/internal/telemetry',
   HQ_TELEMETRY_OUTBOX_PATH:resolve('C:/vvs-staging/private.sqlite')},root)).toThrow('HTTPS or loopback');
 });
});
