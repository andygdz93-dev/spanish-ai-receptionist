import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableTelemetryOutbox } from './operational-outbox.ts';
import definition from './main.ts';
import { RECEPTIONIST_GREETING } from './greeting.ts';

const mock = vi.hoisted(() => ({
  defineAgent: vi.fn((config: unknown) => config),
  runApp: vi.fn(),
  start: vi.fn(async () => {}),
  generateReply: vi.fn(),
  say: vi.fn(),
  on: vi.fn(),
  connect: vi.fn(async () => {}),
  sessionOptions: vi.fn(),
  stt: vi.fn(),
  tts: vi.fn(),
  turnDetector: vi.fn(),
  enhancement: vi.fn((options: unknown) => ({ enhancement: options })),
  agentCreate: vi.fn((config: unknown) => config),
  llm: vi.fn(),
}));

vi.mock('@livekit/agents', () => ({
  defineAgent: mock.defineAgent,
  tool: (options: unknown) => options,
  cli: { runApp: mock.runApp },
  ServerOptions: class {
    constructor(public options: unknown) {}
  },
  Agent: { create: mock.agentCreate },
  dedent: (strings: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: strings.raw }, ...values),
  inference: {
    STT: class {
      constructor(options: unknown) {
        mock.stt(options);
      }
    },
    TTS: class {
      constructor(options: unknown) {
        mock.tts(options);
      }
    },
    TurnDetector: class {
      constructor() {
        mock.turnDetector();
      }
    },
    LLM: class {
      constructor(options: unknown) {
        mock.llm(options);
      }
    },
  },
  voice: {
    AgentSessionEventTypes: { Error: 'error' },
    AgentSession: class {
      constructor(options: unknown) {
        mock.sessionOptions(options);
      }
      start = mock.start;
      generateReply = mock.generateReply;
      say = mock.say;
      on = mock.on;
    },
  },
}));

vi.mock('@livekit/plugins-ai-coustics', () => ({
  EnhancerModel: { QuailVfS: 'quail-vfs' },
  audioEnhancement: mock.enhancement,
}));

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

const entry = (definition as unknown as { entry: (ctx: unknown) => Promise<void> }).entry;
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const fakeContext = () => ({ room: { id: 'synthetic-room' }, connect: mock.connect });

describe('offline voice pipeline configuration (mocked; no audio or network)', () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(mock)) {
      if (name !== 'runApp') value.mockClear();
    }
  });

  it('registers the local agent startup entrypoint', () => {
    expect(mock.runApp).toHaveBeenCalledOnce();
    expect(typeof entry).toBe('function');
  });

  it('configures STT, TTS, and local turn detection', async () => {
    await entry(fakeContext());
    expect(mock.stt).toHaveBeenCalledWith({ model: 'assemblyai/universal-3-6-pro' });
    expect(mock.tts).toHaveBeenCalledWith({
      model: 'fishaudio/s2.1-pro',
      voice: 'd4bd2aebe8344d7288fb23728965da9c',
      language: 'es',
      modelOptions: { speed: 0.98, temperature: 0.75 },
    });
    expect(mock.turnDetector).toHaveBeenCalledOnce();
  });

  it('configures audio enhancement and conversation turn handling', async () => {
    await entry(fakeContext());
    expect(mock.enhancement).toHaveBeenCalledWith({ model: 'quail-vfs' });
    const options = mock.sessionOptions.mock.calls[0]?.[0] as {
      turnHandling: { preemptiveGeneration: { enabled: boolean } };
      expressive: boolean;
    };
    expect(options.turnHandling.preemptiveGeneration.enabled).toBe(true);
    expect(options.expressive).toBe(true);
  });

  it('starts the session before joining and then speaks the exact Spanish greeting directly', async () => {
    const ctx = fakeContext();
    await entry(ctx);
    expect(mock.start).toHaveBeenCalledOnce();
    expect(mock.connect).toHaveBeenCalledOnce();
    expect(mock.say).toHaveBeenCalledOnce();
    expect(mock.say).toHaveBeenCalledWith(RECEPTIONIST_GREETING);
    expect(mock.generateReply).not.toHaveBeenCalled();
    expect(mock.start.mock.invocationCallOrder[0]).toBeLessThan(
      mock.connect.mock.invocationCallOrder[0],
    );
    expect(mock.connect.mock.invocationCallOrder[0]).toBeLessThan(
      mock.say.mock.invocationCallOrder[0],
    );
  });

  it('uses the same VVZ Smilez greeting in demo mode', async () => {
    vi.stubEnv('DENTAL_DEMO_MODE','yes');
    await entry(fakeContext());
    expect(mock.say).toHaveBeenCalledWith(RECEPTIONIST_GREETING);
    expect(mock.generateReply).not.toHaveBeenCalled();
  });

  it('does not connect or greet if session startup fails', async () => {
    mock.start.mockRejectedValueOnce(new Error('synthetic session failure'));
    await expect(entry(fakeContext())).rejects.toThrow('synthetic session failure');
    expect(mock.connect).not.toHaveBeenCalled();
    expect(mock.say).not.toHaveBeenCalled();
  });


  it('wires the actual mocked entrypoint to recoverable/fatal error events without audio calls', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'vvs-mock-entry-'));
    const outboxPath = join(folder, 'queue.sqlite');
    const secret = 'integration-test-secret-'.padEnd(48,'s');
    vi.stubEnv('HQ_TELEMETRY_PRODUCER_ENABLED','yes');
    vi.stubEnv('HQ_TELEMETRY_SIGNING_SECRET',secret);
    vi.stubEnv('HQ_TELEMETRY_BUSINESS_ID',randomUUID());
    vi.stubEnv('HQ_TELEMETRY_WORKER_ID','mock-worker-entry');
    vi.stubEnv('HQ_TELEMETRY_ENDPOINT','http://127.0.0.1:8787/api/internal/telemetry');
    vi.stubEnv('HQ_TELEMETRY_OUTBOX_PATH',outboxPath);
    const sent: Array<{type:string;errorCode?:string}> = [];
    vi.stubGlobal('fetch',vi.fn(async (_url:string,init:RequestInit)=>{
      sent.push(JSON.parse(String(init.body)));
      return Response.json({status:'accepted',eventId:JSON.parse(String(init.body)).eventId},{status:202});
    }));
    const callbacks:Array<()=>Promise<void>>=[];
    try {
      await entry({
        room:{name:'no patient room metadata'},
        job:{id:'AJ_MOCK_ENTRY_01'},
        connect:mock.connect,
        addShutdownCallback:(callback:()=>Promise<void>)=>{callbacks.push(callback);},
      });
      expect(mock.on).toHaveBeenCalledWith('error',expect.any(Function));
      const handler = mock.on.mock.calls[0]?.[1] as ((event:{error:{recoverable:boolean}})=>void);
      handler({error:{recoverable:true}});
      handler({error:{recoverable:false}});
      await callbacks[0]!();
      expect(sent.map(item=>item.type)).toEqual(['call_started','call_failed']);
      expect(sent[1]?.errorCode).toBe('agent_session_error');
      const outbox=new DurableTelemetryOutbox(outboxPath);
      try {expect(outbox.summary().delivered).toBe(2);}finally{outbox.close();}
    }finally{
      rmSync(folder,{force:true,recursive:true,maxRetries:8,retryDelay:150});
    }
  });

  it('does not greet if room connection fails', async () => {
    mock.connect.mockRejectedValueOnce(new Error('synthetic connection failure'));
    await expect(entry(fakeContext())).rejects.toThrow('synthetic connection failure');
    expect(mock.say).not.toHaveBeenCalled();
  });
});
