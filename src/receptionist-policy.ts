export const receptionistPolicy = {
  language: 'es-MX',
  englishOnRequest: true,
  identifyAsVirtualAssistant: true,
  capabilities: {
    answerVerifiedQuestions: true,
    collectAppointmentRequests: true,
    confirmBookings: false,
    collectMessages: true,
    deliverMessages: false,
    transferCalls: false,
  },
} as const;

export type ReceptionistCapability =
  keyof typeof receptionistPolicy.capabilities;

export function canPerform(
  capability: ReceptionistCapability,
): boolean {
  return receptionistPolicy.capabilities[capability];
}
