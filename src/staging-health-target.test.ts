import { describe, expect, it } from 'vitest';
import { readStagingHealthTarget, assertStagingListener, readStagingWorkerServerConfig } from './staging-health-target.ts';

const valid = {
  VVS_RUNTIME_PROFILE:'staging',VVS_STAGING_CREDENTIALS_CONFIRMED:'yes',
  STAGING_NATIVE_HEALTH_URL:'http://127.0.0.1:18081/',
  STAGING_NATIVE_HEALTH_EXPECTED_PID:'4567',
};
describe('dedicated staging native health target and identity',()=>{
  it('requires explicit approved staging configuration and a separate PID',()=>{
    expect(()=>readStagingHealthTarget({})).toThrow('approved staging');
    expect(()=>readStagingHealthTarget({
      ...valid,VVS_STAGING_CREDENTIALS_CONFIRMED:'no',
    })).toThrow('approved staging');
    expect(()=>readStagingHealthTarget({
      ...valid,STAGING_NATIVE_HEALTH_EXPECTED_PID:'',
    })).toThrow('expected worker PID');
    expect(()=>readStagingHealthTarget({
      ...valid,STAGING_NATIVE_HEALTH_EXPECTED_PID:String(process.pid),
    })).toThrow('separate worker process');
  });
  it('forbids implicit, external and existing-worker health targets',()=>{
    for(const url of [
      'http://127.0.0.1:8081/','http://127.0.0.1:8787/',
      'https://example.com/','http://localhost:18081/',
      'http://127.0.0.1:18081/?room=secret',
      'http://127.0.0.1:18081/other',
    ]){
      expect(()=>readStagingHealthTarget({
        ...valid,STAGING_NATIVE_HEALTH_URL:url,
      })).toThrow('dedicated loopback');
    }
  });
  it('accepts the explicit, dedicated staging listener',()=>{
    expect(readStagingHealthTarget(valid)).toEqual({
      url:'http://127.0.0.1:18081/',port:18081,expectedPid:4567,
    });
  });
  it('configures a dedicated loopback stage worker without changing the normal worker',()=>{
    expect(readStagingWorkerServerConfig({})).toBeNull();
    expect(()=>readStagingWorkerServerConfig({
      ...valid,STAGING_LIVEKIT_URL:'wss://staging.livekit.invalid',
      LIVEKIT_URL:'wss://other.livekit.invalid',
    })).toThrow('matching LiveKit project URL');
    expect(readStagingWorkerServerConfig({
      ...valid,STAGING_LIVEKIT_URL:'wss://staging.livekit.invalid',
      LIVEKIT_URL:'wss://staging.livekit.invalid',
    })).toEqual({host:'127.0.0.1',port:18081});
    expect(()=>readStagingWorkerServerConfig({
      ...valid,STAGING_LIVEKIT_URL:'wss://staging.livekit.invalid',
      LIVEKIT_URL:'wss://staging.livekit.invalid',
    },['start','--url','wss://production.invalid'])).toThrow('forbids CLI overrides');
    expect(()=>readStagingWorkerServerConfig({
      ...valid,STAGING_LIVEKIT_URL:'http://staging.livekit.invalid',
      LIVEKIT_URL:'http://staging.livekit.invalid',
    })).toThrow('secure WebSocket');
    expect(()=>readStagingWorkerServerConfig({
      ...valid,STAGING_NATIVE_HEALTH_URL:'http://127.0.0.1:8081/',
      STAGING_LIVEKIT_URL:'wss://staging.livekit.invalid',
      LIVEKIT_URL:'wss://staging.livekit.invalid',
    })).toThrow('dedicated loopback');
  });
  it('requires verified OS ownership before making health claims',async()=>{
    const stage=readStagingHealthTarget(valid);
    await expect(assertStagingListener(stage,async()=>null)).rejects.toThrow('does not match');
    await expect(assertStagingListener(stage,async()=>4577)).rejects.toThrow('does not match');
    await expect(assertStagingListener(stage,async(port)=>{
      expect(port).toBe(18081);return 4567;
    })).resolves.toBeUndefined();
  });
});
