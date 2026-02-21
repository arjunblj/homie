export interface ObservationCounters {
  /** Running average of our response length (chars). */
  avgResponseLength: number;
  /** Running average of their message length (chars). */
  avgTheirMessageLength: number;
  /** Bitmask of hours they're typically active (24 bits, LSB = hour 0). */
  activeHoursBitmask: number;
  /** Total conversation count. */
  conversationCount: number;
  /** Number of samples in the running averages. */
  sampleCount: number;
}

export const EMPTY_COUNTERS: ObservationCounters = {
  avgResponseLength: 0,
  avgTheirMessageLength: 0,
  activeHoursBitmask: 0,
  conversationCount: 0,
  sampleCount: 0,
};

export function updateCounters(
  current: ObservationCounters,
  observation: {
    responseLength: number;
    theirMessageLength: number;
    hourOfDay: number;
    isNewConversation: boolean;
  },
): ObservationCounters {
  const n = current.sampleCount + 1;
  const avgResponseLength =
    current.avgResponseLength + (observation.responseLength - current.avgResponseLength) / n;
  const avgTheirMessageLength =
    current.avgTheirMessageLength +
    (observation.theirMessageLength - current.avgTheirMessageLength) / n;
  const activeHoursBitmask = current.activeHoursBitmask | (1 << observation.hourOfDay);
  const conversationCount = current.conversationCount + (observation.isNewConversation ? 1 : 0);

  return {
    avgResponseLength,
    avgTheirMessageLength,
    activeHoursBitmask,
    conversationCount,
    sampleCount: n,
  };
}
