export {
  type HostBridge,
  type HostDialogBridge,
  type HostKind,
  type HostShellBridge,
  type HostWindowBridge,
  type InvokeArgs,
  type WindowRole,
} from './bridge';
export { CoreUnavailableError, READY_QUEUE_TIMEOUT_MS, YaqmcClient } from './client';
export {
  dispatchPlayerCommand,
  setPlayerCommandAdapter,
  type PlayerCommand,
  type PlayerCommandAdapter,
} from './player-command-adapter';
export { createElectronBridge } from './bridges/electron';
export { createFakeBridge, type FakeCatalog } from './bridges/fake';
export {
  CHANNEL_ACCOUNT_CHANGED,
  CHANNEL_API_EVENT,
  CHANNEL_APP_OPEN_SETTINGS,
  CHANNEL_CORE_LOG,
  CHANNEL_HOST_COMMAND,
  CHANNEL_HOST_CORE_STATUS,
  CHANNEL_HOST_UPDATE,
  CHANNEL_LYRICS_DOCUMENT,
  CHANNEL_LYRICS_PROJECTION,
  CHANNEL_LYRICS_SURFACE_CLOSED,
  CHANNEL_PLAYER_SNAPSHOT,
  CHANNEL_PLUGIN_CHANGED,
  CHANNEL_PREFERENCES_CHANGED,
  CORE_EVENT_CHANNELS,
  HOST_EVENT_CHANNELS,
  type ChannelName,
  type ChannelPayload,
  type CoreChannelName,
  type CoreStatus,
  type CoreStatusPayload,
  type HostChannelName,
  type UpdatePayload,
  type UpdateState,
} from './protocol/events';
export {
  METHOD_NAMES,
  PROTOCOL_ONLY_METHODS,
  TAURI_METHOD_NAMES,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type ParamsOf,
  type ProtocolOnlyMethodName,
  type ResultOf,
  type TauriMethodName,
} from './protocol/methods';
export {
  DEFAULT_METHOD_PAYLOAD_BYTES,
  ERROR_CODES,
  FRAME_HARD_CAP_BYTES,
  HANDSHAKE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SHUTDOWN_TIMEOUT_MS,
  type CoreError,
  type CoreIdentity,
  type CoreMessage,
  type ErrorCode,
  type HostIdentity,
  type PlatformAttach,
  type PlatformKind,
  type DisplayBackend,
  type ResponseBody,
  type ShutdownReason,
} from './protocol/types';
export type * from './protocol/dto';
