import { describe, expect, it, vi, afterEach } from 'vitest';
import { hideNativeLyrics, onNativeLyricsSeek, showNativeLyrics } from './native-lyrics-bridge';
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
        align: 'center',
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
      align: 'left',
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
          align: 'left',
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
  });
});
