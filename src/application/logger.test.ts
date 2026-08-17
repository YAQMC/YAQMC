import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('./yaqmc-runtime', () => ({
  getYaqmcClient: () => ({
    invoke: invokeMock,
  }),
}));

vi.mock('./native-player-runtime', () => ({
  isNativeRuntime: true,
}));

import {
  __testing,
  CONSOLE_FORWARD_TARGET,
  installPackagedConsoleForward,
  isPackagedElectronMainRenderer,
  logger,
  parseConsoleForwardMode,
  setConsoleForwardMode,
  shouldForwardPackagedConsole,
} from './logger';

describe('frontend logger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    __testing.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    __testing.reset();
  });

  it('queues entries and flushes them in a single IPC after the debounce window', async () => {
    logger.info('ui.navigation', 'entered settings', { page: 'about' });
    logger.warn('lyrics.surface', 'projection missed');
    expect(__testing.queueSize()).toBe(2);

    await vi.advanceTimersByTimeAsync(500);
    await logger.flush();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, payload] = invokeMock.mock.calls[0] ?? [];
    expect(command).toBe('diagnostics_log_frontend');
    expect(payload).toMatchObject({
      entries: [
        expect.objectContaining({
          level: 'info',
          target: 'ui.navigation',
          message: 'entered settings',
        }),
        expect.objectContaining({ level: 'warn', target: 'lyrics.surface' }),
      ],
    });
  });

  it('mirrors errors into the diagnostics ring buffer', async () => {
    logger.error('ui.error', new Error('render failed'), undefined, 'op-abc');
    await logger.flush();

    expect(invokeMock).toHaveBeenCalledWith(
      'diagnostics_record_error',
      expect.objectContaining({
        request: expect.objectContaining({
          code: 'YAQMC-UI-EVENT',
          domain: 'ui.error',
          opId: 'op-abc',
        }),
      }),
    );
  });

  it('replaces oversized field bags with a truncation note', async () => {
    const big = 'x'.repeat(6000);
    logger.debug('perf', 'sample', { big });
    await logger.flush();

    const call = invokeMock.mock.calls.find(([name]) => name === 'diagnostics_log_frontend');
    expect(call).toBeDefined();
    const entries = (call?.[1] as { entries: Array<{ fields?: Record<string, unknown> }> }).entries;
    expect(entries[0]?.fields).toEqual(expect.objectContaining({ note: expect.any(String) }));
  });
});

describe('packaged renderer console forward', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    __testing.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    __testing.reset();
  });

  function fakeConsole() {
    const calls: Array<{ level: 'error' | 'warn'; args: unknown[] }> = [];
    return {
      calls,
      error: (...args: unknown[]) => {
        calls.push({ level: 'error', args });
      },
      warn: (...args: unknown[]) => {
        calls.push({ level: 'warn', args });
      },
    };
  }

  it('parses the preference with error as the default', () => {
    expect(parseConsoleForwardMode(null)).toBe('error');
    expect(parseConsoleForwardMode('off')).toBe('off');
    expect(parseConsoleForwardMode('warn')).toBe('warn');
    expect(parseConsoleForwardMode('nope')).toBe('error');
  });

  it('installs only for packaged Electron main', () => {
    expect(
      shouldForwardPackagedConsole({ native: true, packaged: false, windowRole: 'main' }),
    ).toBe(false);
    expect(
      shouldForwardPackagedConsole({
        native: true,
        packaged: true,
        windowRole: 'lyrics-desktop',
      }),
    ).toBe(false);
    expect(
      shouldForwardPackagedConsole({ native: false, packaged: true, windowRole: 'main' }),
    ).toBe(false);
    expect(shouldForwardPackagedConsole({ native: true, packaged: true, windowRole: 'main' })).toBe(
      true,
    );
    expect(
      isPackagedElectronMainRenderer({ windowRole: 'main', hostInfo: { packaged: true } }, true),
    ).toBe(true);
    expect(
      isPackagedElectronMainRenderer(
        { windowRole: 'lyrics-island', hostInfo: { packaged: true } },
        true,
      ),
    ).toBe(false);
  });

  it('does not wrap console when the host is not packaged main', () => {
    expect(
      installPackagedConsoleForward({
        native: true,
        host: { packaged: true, windowRole: 'lyrics-desktop' },
        readMode: async () => null,
      }),
    ).toBe(false);
  });

  it('forwards console.error through diagnostics_log_frontend and keeps the original console', async () => {
    const sink = fakeConsole();
    expect(
      installPackagedConsoleForward({
        native: true,
        host: { packaged: true, windowRole: 'main' },
        consoleObject: sink,
        readMode: async () => null,
      }),
    ).toBe(true);

    sink.error('boom', { cookie: 'qm_keyst=secret' });
    expect(sink.calls).toEqual([{ level: 'error', args: ['boom', { cookie: 'qm_keyst=secret' }] }]);
    expect(__testing.queueSize()).toBe(1);

    await logger.flush();
    const call = invokeMock.mock.calls.find(([name]) => name === 'diagnostics_log_frontend');
    expect(call?.[1]).toMatchObject({
      entries: [
        expect.objectContaining({
          level: 'error',
          target: CONSOLE_FORWARD_TARGET,
          message: expect.stringContaining('boom'),
        }),
      ],
    });
  });

  it('does not re-enter when logger echoes to console', () => {
    const sink = fakeConsole();
    installPackagedConsoleForward({
      native: true,
      host: { packaged: true, windowRole: 'main' },
      consoleObject: sink,
      readMode: async () => null,
    });
    sink.error('once');
    expect(__testing.queueSize()).toBe(1);
  });

  it('truncates oversized console messages before enqueue', async () => {
    const sink = fakeConsole();
    installPackagedConsoleForward({
      native: true,
      host: { packaged: true, windowRole: 'main' },
      consoleObject: sink,
      readMode: async () => null,
    });
    sink.error('x'.repeat(6000));
    await logger.flush();
    const call = invokeMock.mock.calls.find(([name]) => name === 'diagnostics_log_frontend');
    const message = (call?.[1] as { entries: Array<{ message: string }> }).entries[0]?.message;
    expect(message).toContain('[truncated]');
    expect(message && message.length < 6000).toBe(true);
  });

  it('leaves console.warn off until the preference is warn', async () => {
    const sink = fakeConsole();
    installPackagedConsoleForward({
      native: true,
      host: { packaged: true, windowRole: 'main' },
      consoleObject: sink,
      readMode: async () => null,
    });
    sink.warn('noisy');
    expect(__testing.queueSize()).toBe(0);

    setConsoleForwardMode('warn');
    sink.warn('degraded');
    expect(__testing.queueSize()).toBe(1);
    await logger.flush();
    const call = invokeMock.mock.calls.find(([name]) => name === 'diagnostics_log_frontend');
    expect(call?.[1]).toMatchObject({
      entries: [expect.objectContaining({ level: 'warn', target: CONSOLE_FORWARD_TARGET })],
    });
  });

  it('stops forwarding when the preference is off', () => {
    const sink = fakeConsole();
    installPackagedConsoleForward({
      native: true,
      host: { packaged: true, windowRole: 'main' },
      consoleObject: sink,
      readMode: async () => null,
    });
    setConsoleForwardMode('off');
    sink.error('silent');
    expect(__testing.queueSize()).toBe(0);
  });

  it('is idempotent', () => {
    const sink = fakeConsole();
    const options = {
      native: true,
      host: { packaged: true, windowRole: 'main' as const },
      consoleObject: sink,
      readMode: async () => null,
    };
    expect(installPackagedConsoleForward(options)).toBe(true);
    expect(installPackagedConsoleForward(options)).toBe(true);
  });
});
