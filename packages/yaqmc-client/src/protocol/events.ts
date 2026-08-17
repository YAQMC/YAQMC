/** Filled in CLIENT-02 from ADR-004 channel names. */
export const CORE_EVENT_CHANNELS = [] as const;
export const HOST_EVENT_CHANNELS = [] as const;

export type ChannelName =
  (typeof CORE_EVENT_CHANNELS)[number] | (typeof HOST_EVENT_CHANNELS)[number];
