import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from './agent.ts';

const { createMock, llmMock } = vi.hoisted(() => ({
  createMock: vi.fn((config: unknown) => config),
  llmMock: vi.fn(),
}));

vi.mock('@livekit/agents', () => ({
  Agent: { create: createMock },
  dedent: (strings: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: strings.raw }, ...values)
      .replace(/^ {6}/gm, '')
      .trim(),
  inference: {
    LLM: class {
      constructor(options: unknown) {
        llmMock(options);
      }
    },
  },
}));

function prompt(): string {
  const config = createAgent() as { instructions: string };
  return config.instructions;
}

describe('offline agent configuration contract (not live conversation output)', () => {
  beforeEach(() => {
    createMock.mockClear();
    llmMock.mockClear();
  });

  it('creates an agent with a configured inference LLM', () => {
    const config = createAgent() as { instructions: string; llm: unknown };
    expect(createMock).toHaveBeenCalledOnce();
    expect(config.llm).toBeTruthy();
    expect(llmMock).toHaveBeenCalledWith({ model: 'google/gemma-4-31b-it' });
  });

  it('uses Mexican Spanish and identifies as a virtual assistant', () => {
    const text = prompt();
    expect(text).toContain('M\u00e9xico');
    expect(text).toContain('espa\u00f1ol mexicano');
    expect(text).toContain('asistente virtual');
  });

  it('switches to English only when the caller requests it', () => {
    expect(prompt()).toContain(
      'Cambia al ingl\u00e9s \u00fanicamente cuando el cliente lo solicite.',
    );
  });

  it('requires short natural telephone responses and one question at a time', () => {
    const text = prompt();
    expect(text).toContain('una o tres oraciones');
    expect(text).toContain('una pregunta a la vez');
    expect(text).toContain('llamadas telef\u00f3nicas');
  });

  it('uses conversational Mexican Spanish without repetitive formal phrasing', () => {
    const text = prompt();
    expect(text).toContain('recepcionista mexicana real');
    expect(text).toContain('no las repitas en todas las respuestas');
    expect(text).toContain('pide una aclaración breve en lugar de adivinar');
  });

  it('prohibits invented business names, hours, prices, and services', () => {
    const text = prompt();
    expect(text).toContain('No inventes el nombre');
    expect(text).toContain('No inventes horarios, precios, promociones ni servicios.');
  });

  it('collects appointment requests without confirming bookings or availability', () => {
    const text = prompt();
    expect(text).toContain(
      'Atiende solicitudes de citas dentales: confirma únicamente si existe un resultado exitoso',
    );
    expect(text).toContain('No afirmes que existe disponibilidad sin consultar con éxito');
    expect(text).toContain(
      'No confirmes una cita sin una herramienta de reservaci\u00f3n exitosa.',
    );
  });

  it('does not pretend appointment requests were persisted before storage is connected', () => {
    const text = prompt();
    expect(text).toContain('Nunca afirmes que registraste, guardaste, enviaste o notificaste');
    expect(text).toContain('la cita no está confirmada ni la solicitud guardada o enviada');
    expect(text).toContain('Pregunta primero por el servicio');
  });

  it('collects messages without claiming delivery or promising callbacks', () => {
    const text = prompt();
    expect(text).toContain('Permite que el cliente deje un recado.');
    expect(text).toContain(
      'no afirmes que el recado fue guardado, registrado, enviado o entregado.',
    );
    expect(text).toContain('No prometas que alguien devolver\u00e1 la llamada.');
  });

  it('recognizes human requests without pretending to transfer calls', () => {
    const text = prompt();
    expect(text).toContain('Reconoce cuando el cliente solicita hablar con una persona.');
    expect(text).toContain('No afirmes que realizaste una transferencia.');
  });

  it('respects refusal to provide a phone number or sensitive information', () => {
    const text = prompt();
    expect(text).toContain('Respeta cuando el cliente no quiera proporcionar informaci\u00f3n.');
    expect(text).toContain('No presiones para obtener n\u00fameros telef\u00f3nicos.');
    expect(text).toContain('No solicites informaci\u00f3n financiera ni datos sensibles.');
  });

  it('does not claim nonexistent tools or completed actions', () => {
    const text = prompt();
    expect(text).toContain('No afirmes que consultaste sistemas inexistentes.');
    expect(text).toContain('No afirmes haber realizado acciones sin confirmaci\u00f3n.');
  });

  it('prescribes a transparent end-of-call summary', () => {
    const text = prompt();
    expect(text).toContain('Resume brevemente lo solicitado');
    expect(text).toContain('Aclara qu\u00e9 acciones no se han completado.');
  });
});
