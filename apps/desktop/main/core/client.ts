import {
  type CoreError,
  type CoreMessage,
  type ErrorCode,
  FRAME_HARD_CAP_BYTES,
} from '@yaqmc/client';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { FrameDecoder, ProtocolError, writeFrame } from './frames';

export const CONTROL_TIMEOUT_MS = 10_000;
export const STANDARD_TIMEOUT_MS = 30_000;
export const LONG_TIMEOUT_MS = 120_000;

const LONG_METHODS = new Set([
  'plugin_install',
  'plugin_install_unpacked',
  'plugin_reload',
  'diagnostics_export_bundle',
  'platform_export_diagnostics',
]);

const KNOWN_KINDS = new Set([
  'hello',
  'attach',
  'ready',
  'request',
  'response',
  'event',
  'shutdown',
  'shutdown-ack',
]);

export function methodTimeoutMs(method: string): number {
  if (method.startsWith('player_') || method === 'core_ping') {
    return CONTROL_TIMEOUT_MS;
  }
  if (LONG_METHODS.has(method)) {
    return LONG_TIMEOUT_MS;
  }
  return STANDARD_TIMEOUT_MS;
}

export class CoreInvokeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CoreInvokeError';
  }

  static fromCore(error: CoreError): CoreInvokeError {
    return new CoreInvokeError(
      asErrorCode(error.code),
      error.message,
      error.retryable,
      error.details,
    );
  }
}

export type CoreStream = {
  readable: Readable;
  writable: Writable;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CoreClient extends EventEmitter {
  private readonly decoder: FrameDecoder;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private lastSeq: number | undefined;
  private closed = false;
  private started = false;

  constructor(
    private readonly stream: CoreStream,
    limit = FRAME_HARD_CAP_BYTES,
  ) {
    super();
    this.decoder = new FrameDecoder(limit);
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stream.readable.on('data', (chunk: Buffer) => {
      try {
        for (const payload of this.decoder.push(chunk)) {
          this.dispatch(decodeMessage(payload));
        }
      } catch (error) {
        this.fail(asError(error));
      }
    });
    this.stream.readable.on('end', () => {
      this.fail(new ProtocolError('protocol connection closed', false));
    });
    this.stream.readable.on('error', (error: Error) => {
      this.fail(error);
    });
  }

  async send(message: CoreMessage): Promise<void> {
    if (this.closed) {
      throw new ProtocolError('protocol connection closed', false);
    }
    await writeFrame(this.stream.writable, Buffer.from(JSON.stringify(message)));
  }

  invoke(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.nextId;
    const message: CoreMessage =
      params === undefined
        ? { kind: 'request', id, method }
        : { kind: 'request', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CoreInvokeError('core.timeout', `${method} timed out`, true));
      }, methodTimeoutMs(method));
      this.pending.set(id, { resolve, reject, timer });
      void this.send(message).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(asError(error));
      });
    });
  }

  close(error?: Error): void {
    this.fail(error ?? new ProtocolError('protocol connection closed', false));
  }

  private dispatch(message: CoreMessage): void {
    this.emit('message', message);
    if (message.kind === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(CoreInvokeError.fromCore(message.error));
      }
      return;
    }
    if (message.kind === 'event') {
      if (this.lastSeq !== undefined && message.seq !== this.lastSeq + 1) {
        this.emit('resync', { previous: this.lastSeq, seq: message.seq });
      }
      this.lastSeq = message.seq;
      this.emit('event', message);
    }
  }

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    }
    this.emit('close', error);
  }
}

export function decodeMessage(payload: Uint8Array): CoreMessage {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload).toString('utf8')) as unknown;
  } catch (error) {
    throw new ProtocolError(
      `invalid JSON frame: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (value === null || typeof value !== 'object' || !('kind' in value)) {
    throw new ProtocolError('invalid JSON frame: missing kind');
  }
  const kind = (value as { kind: unknown }).kind;
  if (typeof kind !== 'string') {
    throw new ProtocolError('invalid JSON frame: missing kind');
  }
  if (!KNOWN_KINDS.has(kind)) {
    throw new ProtocolError(`unknown message kind ${kind}`);
  }
  return value as CoreMessage;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new ProtocolError(String(error));
}

function asErrorCode(code: string): ErrorCode {
  switch (code) {
    case 'core.command_error':
    case 'core.unavailable':
    case 'core.timeout':
    case 'core.protocol':
    case 'host.denied':
      return code;
    default:
      return 'core.protocol';
  }
}
