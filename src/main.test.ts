import { beforeEach, describe, expect, it, vi } from 'vitest';
import definition from './main.ts';

const mock = vi.hoisted(() => ({
  defineAgent: vi.fn((config: unknown) => config),
  runApp: vi.fn(),
  start: vi.fn(async () => {}),
  generateReply: vi.fn(),
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
    AgentSession: class {
      constructor(options: unknown) {
        mock.sessionOptions(options);
      }
      start = mock.start;
      generateReply = mock.generateReply;
    },
  },
}));

vi.mock('@livekit/plugins-ai-coustics', () => ({
  EnhancerModel: { QuailVfS: 'quail-vfs' },
  audioEnhancement: mock.enhancement,
}));

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

const entry = (definition as unknown as { entry: (ctx: unknown) => Promise<void> }).entry;
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

  it('starts the session before joining and then generates a Spanish greeting', async () => {
    const ctx = fakeContext();
    await entry(ctx);
    expect(mock.start).toHaveBeenCalledOnce();
    expect(mock.connect).toHaveBeenCalledOnce();
    expect(mock.generateReply).toHaveBeenCalledOnce();
    const greeting = mock.generateReply.mock.calls[0]?.[0] as { instructions: string };
    expect(greeting.instructions).toContain('espa\u00f1ol mexicano');
    expect(greeting.instructions).toContain('asistente virtual');
    expect(mock.start.mock.invocationCallOrder[0]).toBeLessThan(
      mock.connect.mock.invocationCallOrder[0],
    );
    expect(mock.connect.mock.invocationCallOrder[0]).toBeLessThan(
      mock.generateReply.mock.invocationCallOrder[0],
    );
  });

  it('does not connect or greet if session startup fails', async () => {
    mock.start.mockRejectedValueOnce(new Error('synthetic session failure'));
    await expect(entry(fakeContext())).rejects.toThrow('synthetic session failure');
    expect(mock.connect).not.toHaveBeenCalled();
    expect(mock.generateReply).not.toHaveBeenCalled();
  });

  it('does not greet if room connection fails', async () => {
    mock.connect.mockRejectedValueOnce(new Error('synthetic connection failure'));
    await expect(entry(fakeContext())).rejects.toThrow('synthetic connection failure');
    expect(mock.generateReply).not.toHaveBeenCalled();
  });
});
