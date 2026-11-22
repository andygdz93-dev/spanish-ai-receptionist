import { describe, expect, it } from 'vitest';
import { canPerform, receptionistPolicy } from './receptionist-policy.ts';

describe('Mexican-Spanish receptionist policy', () => {
  it('uses Mexican Spanish by default', () => {
    expect(receptionistPolicy.language).toBe('es-MX');
  });

  it('identifies as a virtual assistant', () => {
    expect(receptionistPolicy.identifyAsVirtualAssistant).toBe(true);
  });

  it('supports English on request', () => {
    expect(receptionistPolicy.englishOnRequest).toBe(true);
  });

  it.each(['answerVerifiedQuestions', 'collectAppointmentRequests', 'collectMessages'] as const)(
    'allows %s',
    (capability) => {
      expect(canPerform(capability)).toBe(true);
    },
  );

  it.each(['confirmBookings', 'deliverMessages', 'transferCalls'] as const)(
    'blocks %s',
    (capability) => {
      expect(canPerform(capability)).toBe(false);
    },
  );

  it('defines exactly six capabilities', () => {
    expect(Object.keys(receptionistPolicy.capabilities)).toHaveLength(6);
  });
});
