import { isNativeRuntime } from './native-player-runtime';
import { getYaqmcClient } from './yaqmc-runtime';

const client = getYaqmcClient();

/**
 * Batched frontend logger that mirrors the Rust logging pipeline. Records are
 * enqueued locally and forwarded to the native runtime as a single IPC per flush
 * so real-time UI code (lyrics animation, playback callbacks) never pays a
 * per-event IPC cost.
 *
 * The public API is deliberately minimal:
 *   - `logger.info('ui.navigation', { page })`
 *   - `logger.warn('lyrics.surface', { reason })`
 *   - `logger.error('ui.error', new Error(...))`
 *
 * Nothing sensitive is expected in fields; if a record accidentally contains a
 * secret-shaped value the Rust `RedactingWriter` scrubs it before disk write.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type ConsoleForwardMode = 'off' | 'error' | 'warn';

/** app_settings key. Missing value means packaged error-forwarding is on (§27.1). */
export const CONSOLE_FORWARD_SETTING_KEY = 'logging.consoleForward';
export const CONSOLE_FORWARD_TARGET = 'ui.console';

export interface LogEntry {
  level: LogLevel;
  target: string;
  message: string;
  opId?: string;
  fields?: Record<string, unknown>;
}

const MAX_QUEUE = 128;
const FLUSH_INTERVAL_MS = 400;
const MAX_MESSAGE_BYTES = 2_048;
const MAX_FIELDS_BYTES = 4_096;

const queue: LogEntry[] = [];
let flushHandle: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let consoleForwardMode: ConsoleForwardMode = 'error';
let capturingConsole = false;
let installedConsole: Pick<Console, 'error' | 'warn'> | null = null;
let originalConsoleError: ((...args: unknown[]) => void) | null = null;
let originalConsoleWarn: ((...args: unknown[]) => void) | null = null;

type RendererConsoleHost = {
  windowRole?: unknown;
  hostInfo?: { packaged?: unknown };
};

export function parseConsoleForwardMode(value: unknown): ConsoleForwardMode {
  return value === 'off' || value === 'warn' || value === 'error' ? value : 'error';
}

export function shouldForwardPackagedConsole(input: {
  native: boolean;
  packaged: boolean;
  windowRole: string;
}): boolean {
  return input.native && input.packaged && input.windowRole === 'main';
}

export function readConsoleForwardHost(
  yaqmc: RendererConsoleHost | undefined = Reflect.get(globalThis, 'yaqmc') as
    RendererConsoleHost | undefined,
): { packaged: boolean; windowRole: string } {
  return {
    packaged: yaqmc?.hostInfo?.packaged === true,
    windowRole: typeof yaqmc?.windowRole === 'string' ? yaqmc.windowRole : '',
  };
}

export function isPackagedElectronMainRenderer(
  yaqmc?: RendererConsoleHost,
  native: boolean = isNativeRuntime,
): boolean {
  const host = readConsoleForwardHost(yaqmc);
  return shouldForwardPackagedConsole({ native, ...host });
}

export function setConsoleForwardMode(mode: ConsoleForwardMode): void {
  consoleForwardMode = mode;
}

function consoleLevelAllowed(level: 'error' | 'warn'): boolean {
  if (consoleForwardMode === 'off') return false;
  if (level === 'error') return true;
  return consoleForwardMode === 'warn';
}

function restorePackagedConsoleForward(): void {
  if (installedConsole && originalConsoleError && originalConsoleWarn) {
    installedConsole.error = originalConsoleError;
    installedConsole.warn = originalConsoleWarn;
  }
  installedConsole = null;
  originalConsoleError = null;
  originalConsoleWarn = null;
  capturingConsole = false;
  consoleForwardMode = 'error';
}

function formatConsoleArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  return truncateBytes(args.map((arg) => toMessage(arg)).join(' '), MAX_MESSAGE_BYTES);
}

export function installPackagedConsoleForward(options?: {
  native?: boolean;
  host?: { packaged: boolean; windowRole: string };
  consoleObject?: {
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  readMode?: () => Promise<unknown>;
}): boolean {
  const native = options?.native ?? isNativeRuntime;
  const host = options?.host ?? readConsoleForwardHost();
  if (
    !shouldForwardPackagedConsole({
      native,
      packaged: host.packaged,
      windowRole: host.windowRole,
    })
  ) {
    return false;
  }
  if (installedConsole) {
    return true;
  }
  const target = options?.consoleObject ?? console;
  originalConsoleError = target.error.bind(target);
  originalConsoleWarn = target.warn.bind(target);
  installedConsole = target;
  const wrap = (level: 'error' | 'warn', original: (...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      original(...args);
      if (capturingConsole || !consoleLevelAllowed(level)) return;
      capturingConsole = true;
      try {
        record(level, CONSOLE_FORWARD_TARGET, formatConsoleArgs(args));
      } finally {
        capturingConsole = false;
      }
    };
  };
  target.error = wrap('error', originalConsoleError);
  target.warn = wrap('warn', originalConsoleWarn);
  const readMode =
    options?.readMode ??
    (async () => {
      if (!isNativeRuntime) return null;
      return client.invoke('app_settings_get', { key: CONSOLE_FORWARD_SETTING_KEY });
    });
  void readMode()
    .then((value) => {
      setConsoleForwardMode(parseConsoleForwardMode(value));
    })
    .catch(() => undefined);
  return true;
}

function truncateBytes(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated]`;
}

function toMessage(input: unknown): string {
  if (input instanceof Error) {
    return truncateBytes(input.stack ?? input.message, MAX_MESSAGE_BYTES);
  }
  if (typeof input === 'string') {
    return truncateBytes(input, MAX_MESSAGE_BYTES);
  }
  try {
    return truncateBytes(JSON.stringify(input), MAX_MESSAGE_BYTES);
  } catch {
    return '[unserializable]';
  }
}

function boundFields(fields?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  try {
    const serialized = JSON.stringify(fields);
    if (serialized.length <= MAX_FIELDS_BYTES) return fields;
    return { note: `fields truncated (${serialized.length} bytes)` };
  } catch {
    return { note: 'fields unserializable' };
  }
}

function scheduleFlush(): void {
  if (flushHandle !== null) return;
  flushHandle = setTimeout(() => {
    flushHandle = null;
    void flush();
  }, FLUSH_INTERVAL_MS);
}

async function flush(): Promise<void> {
  if (flushing || queue.length === 0) return;
  const drained = queue.splice(0, queue.length);
  if (!isNativeRuntime) return;
  flushing = true;
  try {
    await client.invoke('diagnostics_log_frontend', {
      entries: drained.map((entry) => ({
        level: entry.level,
        target: entry.target,
        message: entry.message,
        opId: entry.opId,
        fields: entry.fields ?? null,
      })),
    });
  } catch {
    // Never let a logging IPC failure surface to the UI.
  } finally {
    flushing = false;
  }
}

function enqueue(entry: LogEntry): void {
  if (queue.length >= MAX_QUEUE) {
    queue.shift();
  }
  queue.push({
    ...entry,
    message: truncateBytes(entry.message, MAX_MESSAGE_BYTES),
    fields: boundFields(entry.fields),
  });
  scheduleFlush();
}

function record(
  level: LogLevel,
  target: string,
  input: unknown,
  fields?: Record<string, unknown>,
  opId?: string,
): void {
  const message = toMessage(input);
  const entry: LogEntry = { level, target, message, opId, fields };
  enqueue(entry);
  // Also emit to the developer console so the browser preview and Vite dev
  // server keep the familiar debugging surface.
  if (!capturingConsole && (import.meta.env.DEV || !isNativeRuntime)) {
    const consoleMethod =
      level === 'error'
        ? 'error'
        : level === 'warn'
          ? 'warn'
          : level === 'info'
            ? 'info'
            : level === 'debug'
              ? 'debug'
              : 'log';
    console[consoleMethod](`[${target}]`, message, fields ?? '');
  }
  if (level === 'error' && isNativeRuntime) {
    void client
      .invoke('diagnostics_record_error', {
        request: {
          code: 'YAQMC-UI-EVENT',
          domain: target,
          message,
          opId,
        },
      })
      .catch(() => undefined);
  }
}

export const logger = {
  error(target: string, input: unknown, fields?: Record<string, unknown>, opId?: string) {
    record('error', target, input, fields, opId);
  },
  warn(target: string, input: unknown, fields?: Record<string, unknown>, opId?: string) {
    record('warn', target, input, fields, opId);
  },
  info(target: string, input: unknown, fields?: Record<string, unknown>, opId?: string) {
    record('info', target, input, fields, opId);
  },
  debug(target: string, input: unknown, fields?: Record<string, unknown>, opId?: string) {
    record('debug', target, input, fields, opId);
  },
  trace(target: string, input: unknown, fields?: Record<string, unknown>, opId?: string) {
    record('trace', target, input, fields, opId);
  },
  async flush(): Promise<void> {
    if (flushHandle) {
      clearTimeout(flushHandle);
      flushHandle = null;
    }
    await flush();
  },
};

/**
 * Testing hook: reset the module-level queue and any pending flush timer.
 * Not exported through the public barrel; only referenced by tests via the
 * `.__test__` shape below.
 */
export const __testing = {
  queueSize(): number {
    return queue.length;
  },
  drain(): LogEntry[] {
    return queue.splice(0, queue.length);
  },
  reset(): void {
    if (flushHandle) {
      clearTimeout(flushHandle);
      flushHandle = null;
    }
    queue.splice(0, queue.length);
    flushing = false;
    restorePackagedConsoleForward();
  },
  consoleForwardMode(): ConsoleForwardMode {
    return consoleForwardMode;
  },
};
