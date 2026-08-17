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

import { __testing, logger } from './logger';

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
