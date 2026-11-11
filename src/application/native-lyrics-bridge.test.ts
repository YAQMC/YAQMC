import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  hideNativeLyrics,
  onNativeLyricsSeek,
  showNativeLyrics,
  updateNativeLyrics,
} from './native-lyrics-bridge';
import type { RenderLyricLine } from './lyrics-render-model';

describe('native-lyrics-bridge', () => {
  const originalCapacitor = (globalThis as unknown as { Capacitor?: unknown }).Capacitor;

  afterEach(() => {
    (globalThis as unknown as { Capacitor?: unknown }).Capacitor = originalCapacitor;
  });

  it('safely no-ops when Capacitor is not present in runtime', async () => {
    delete (globalThis as unknown as { Capacitor?: unknown }).Capacitor;

    await expect(
      showNativeLyrics(null, [], {
        alignAnchor: 'center',
        textAlign: 'center',
        wordEmphasis: true,
        followAnchor: 0.35,
        enableSpring: true,
        enableScale: true,
        enableBlur: true,
        hidePassedLines: false,
        wordFadeWidth: 1,
      }),
    ).resolves.toBeUndefined();

    await expect(hideNativeLyrics()).resolves.toBeUndefined();

    const unlisten = onNativeLyricsSeek(() => {});
    expect(typeof unlisten).toBe('function');
    unlisten();
  });

  it('invokes lyrics_show and lyrics_hide on the YaqmcNative plugin', async () => {
    const invokeMock = vi.fn().mockResolvedValue({ value: true });
    (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      Plugins: {
        YaqmcNative: {
          invoke: invokeMock,
          addListener: vi.fn(),
        },
      },
    };

    const mockLines: RenderLyricLine[] = [
      {
        sourceLineIndex: 0,
        startTimeMs: 1000,
        endTimeMs: 2000,
        words: [{ startTimeMs: 1000, endTimeMs: 2000, text: 'Hello' }],
        translatedLyric: '',
        romanLyric: '',
        isBackground: false,
        isDuet: false,
      },
    ];

    await showNativeLyrics({ top: 10, left: 20, width: 300, height: 400 }, mockLines, {
      alignAnchor: 'center',
      textAlign: 'left',
      wordEmphasis: true,
      followAnchor: 0.4,
      enableSpring: false,
      enableScale: true,
      enableBlur: false,
      hidePassedLines: true,
      wordFadeWidth: 0.5,
    });

    expect(invokeMock).toHaveBeenCalledWith({
      method: 'lyrics_show',
      params: {
        bounds: { top: 10, left: 20, width: 300, height: 400 },
        lines: mockLines,
        options: {
          alignAnchor: 'center',
          textAlign: 'left',
          wordEmphasis: true,
          followAnchor: 0.4,
          enableSpring: false,
          enableScale: true,
          enableBlur: false,
          hidePassedLines: true,
          wordFadeWidth: 0.5,
        },
      },
    });

    await hideNativeLyrics();
    expect(invokeMock).toHaveBeenCalledWith({
      method: 'lyrics_hide',
    });
    await hideNativeLyrics(true);
    expect(invokeMock).toHaveBeenLastCalledWith({
      method: 'lyrics_hide',
      params: { immediate: true },
    });
  });

  it('updates native geometry and style without resending lyric lines', async () => {
    const invokeMock = vi.fn().mockResolvedValue({ value: true });
    (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      Plugins: {
        YaqmcNative: {
          invoke: invokeMock,
          addListener: vi.fn(),
        },
      },
    };

    await updateNativeLyrics({ top: 2, left: 4, width: 120, height: 80 }, null, {
      alignAnchor: 'center',
      textAlign: 'center',
      wordEmphasis: false,
      followAnchor: 0.35,
      enableSpring: true,
      enableScale: true,
      enableBlur: true,
      hidePassedLines: false,
      wordFadeWidth: 1,
      lineFontSizePx: 24,
      fontWeight: 650,
      foregroundColor: 'rgb(240, 240, 240)',
      timingOffsetMs: -120,
    });

    expect(invokeMock).toHaveBeenCalledWith({
      method: 'lyrics_update',
      params: {
        bounds: { top: 2, left: 4, width: 120, height: 80 },
        options: expect.objectContaining({
          lineFontSizePx: 24,
          fontWeight: 650,
          timingOffsetMs: -120,
        }),
      },
    });
  });

  it('listens for lyricsSeek events and cleans up listener on unsubscribe', async () => {
    let capturedListener: ((payload: Record<string, unknown>) => void) | null = null;
    const removeMock = vi.fn().mockResolvedValue(undefined);
    const addListenerMock = vi.fn().mockImplementation((_event, listener) => {
      capturedListener = listener;
      return Promise.resolve({ remove: removeMock });
    });

    (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      Plugins: {
        YaqmcNative: {
          invoke: vi.fn(),
          addListener: addListenerMock,
        },
      },
    };

    const seekCallback = vi.fn();
    const unsubscribe = onNativeLyricsSeek(seekCallback);

    expect(addListenerMock).toHaveBeenCalledWith('lyricsSeek', expect.any(Function));

    const listenerFn = capturedListener as ((payload: Record<string, unknown>) => void) | null;
    listenerFn?.({ positionMs: 12345 });
    expect(seekCallback).toHaveBeenCalledWith(12345);

    unsubscribe();
    // Flush microtasks for the promise chain
    await Promise.resolve();
    expect(removeMock).toHaveBeenCalled();
    listenerFn?.({ positionMs: 20000 });
    expect(seekCallback).toHaveBeenCalledTimes(1);
  });

  it('handles synchronous listener handle return from native bridge', () => {
    let capturedListener: ((payload: Record<string, unknown>) => void) | null = null;
    const removeMock = vi.fn();
    const addListenerMock = vi.fn().mockImplementation((_event, listener) => {
      capturedListener = listener;
      return { remove: removeMock };
    });

    (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      Plugins: {
        YaqmcNative: {
          invoke: vi.fn(),
          addListener: addListenerMock,
        },
      },
    };

    const seekCallback = vi.fn();
    const unsubscribe = onNativeLyricsSeek(seekCallback);

    expect(addListenerMock).toHaveBeenCalledWith('lyricsSeek', expect.any(Function));

    const listenerFn = capturedListener as ((payload: Record<string, unknown>) => void) | null;
    listenerFn?.({ positionMs: 54321 });
    expect(seekCallback).toHaveBeenCalledWith(54321);

    unsubscribe();
    expect(removeMock).toHaveBeenCalled();
  });

  it('contains asynchronous listener registration failures', async () => {
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const registrationError = new Error('native bridge unavailable');
    const addListenerMock = vi.fn().mockRejectedValue(registrationError);

    (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      Plugins: {
        YaqmcNative: {
          invoke: vi.fn(),
          addListener: addListenerMock,
        },
      },
    };

    onNativeLyricsSeek(vi.fn());
    await vi.waitFor(() =>
      expect(warnMock).toHaveBeenCalledWith(
        'Failed to attach lyricsSeek listener',
        registrationError,
      ),
    );
    warnMock.mockRestore();
  });
});
