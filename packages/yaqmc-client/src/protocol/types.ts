export const PROTOCOL_VERSION = 1;
export const FRAME_HARD_CAP_BYTES = 32 * 1024 * 1024;
export const DEFAULT_METHOD_PAYLOAD_BYTES = 1024 * 1024;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const SHUTDOWN_TIMEOUT_MS = 5_000;

export const ERROR_CODES = [
  'core.command_error',
  'core.unavailable',
  'core.timeout',
  'core.protocol',
  'host.denied',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type PlatformKind = 'windows' | 'linux';
export type DisplayBackend = 'x11' | 'wayland';
export type ShutdownReason = 'quit' | 'restart';

export interface CoreIdentity {
  version: string;
  commit: string;
  channel: string;
}

export interface HostIdentity {
  app: string;
  version: string;
}

export interface PlatformAttach {
  mainWindowHandle?: string;
  platformKind: PlatformKind;
  displayBackend?: DisplayBackend;
}

export interface CoreError {
  code: string;
  message: string;
  details?: unknown;
  retryable: boolean;
}

export type CoreMessage =
  | { kind: 'hello'; protocol: number; core: CoreIdentity }
  | { kind: 'attach'; protocol: number; host: HostIdentity; platform: PlatformAttach }
  | { kind: 'ready' }
  | { kind: 'request'; id: number; method: string; params?: unknown }
  | ({ kind: 'response'; id: number } & ResponseBody)
  | { kind: 'event'; seq: number; channel: string; payload: unknown }
  | { kind: 'shutdown'; reason: ShutdownReason }
  | { kind: 'shutdown-ack' };

export type ResponseBody = { ok: true; result: unknown } | { ok: false; error: CoreError };
