export { type HostBridge, type HostKind, type WindowRole } from './bridge';
export { YaqmcClient } from './client';
export { createElectronBridge } from './bridges/electron';
export { createFakeBridge } from './bridges/fake';
export { CORE_EVENT_CHANNELS, HOST_EVENT_CHANNELS, type ChannelName } from './protocol/events';
export { METHOD_NAMES, type MethodName } from './protocol/methods';
export {
  DEFAULT_METHOD_PAYLOAD_BYTES,
  FRAME_HARD_CAP_BYTES,
  PROTOCOL_VERSION,
} from './protocol/types';
