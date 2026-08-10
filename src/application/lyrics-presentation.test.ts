import { beforeEach, describe, expect, it } from 'vitest';
import {
  lyricsEscapeAction,
  setFullscreenPortForTests,
  shouldShowLyricSecondary,
  startLyricsPresentationRuntime,
  useLyricsPresentationStore,
  type FullscreenPort,
} from './lyrics-presentation';

class FakeFullscreenPort implements FullscreenPort {
  fullscreen = false;
  listener: (() => void) | null = null;
  fail = false;

  async read() {
    return this.fullscreen;
  }

  async write(value: boolean) {
    if (this.fail) throw new Error('denied');
    this.fullscreen = value;
  }

  async subscribe(listener: () => void) {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('lyrics presentation state', () => {
  let port: FakeFullscreenPort;

  beforeEach(() => {
    port = new FakeFullscreenPort();
    setFullscreenPortForTests(port);
  });

  it('confirms successful fullscreen entry through a fresh read', async () => {
    await expect(useLyricsPresentationStore.getState().request(true)).resolves.toBe(true);

    expect(useLyricsPresentationStore.getState()).toEqual(
      expect.objectContaining({ fullscreen: true, pending: false, error: null }),
    );
  });

  it('keeps the confirmed value and exposes the message when entry is rejected', async () => {
    port.fail = true;

    await expect(useLyricsPresentationStore.getState().request(true)).resolves.toBe(false);

    expect(useLyricsPresentationStore.getState()).toEqual(
      expect.objectContaining({ fullscreen: false, pending: false, error: 'denied' }),
    );
  });

  it('clears a fullscreen request error without changing the confirmed value', async () => {
    port.fail = true;
    await useLyricsPresentationStore.getState().request(true);

    useLyricsPresentationStore.getState().clearError();

    expect(useLyricsPresentationStore.getState()).toEqual(
      expect.objectContaining({ fullscreen: false, pending: false, error: null }),
    );
  });

  it('synchronizes an external fullscreen exit after a resize wake-up', async () => {
    port.fullscreen = true;
    await useLyricsPresentationStore.getState().sync();
    const cleanup = await startLyricsPresentationRuntime();
    port.fullscreen = false;

    port.listener?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(useLyricsPresentationStore.getState().fullscreen).toBe(false);
    await cleanup();
    expect(port.listener).toBeNull();
  });

  it('coalesces resize wake-ups and never treats the event as fullscreen evidence', async () => {
    let reads = 0;
    port.read = async () => {
      reads += 1;
      return port.fullscreen;
    };
    const cleanup = await startLyricsPresentationRuntime();

    port.listener?.();
    port.listener?.();
    port.listener?.();
    expect(useLyricsPresentationStore.getState().fullscreen).toBe(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(reads).toBe(1);
    expect(useLyricsPresentationStore.getState().fullscreen).toBe(false);
    await cleanup();
  });

  it('discards a stale request confirmation when a newer request wins', async () => {
    const firstRead = deferred<boolean>();
    let readCount = 0;
    port.write = async () => undefined;
    port.read = async () => {
      readCount += 1;
      return readCount === 1 ? firstRead.promise : false;
    };

    const staleRequest = useLyricsPresentationStore.getState().request(true);
    await Promise.resolve();
    const latestRequest = useLyricsPresentationStore.getState().request(false);
    await expect(latestRequest).resolves.toBe(false);
    firstRead.resolve(true);
    await expect(staleRequest).resolves.toBe(false);

    expect(useLyricsPresentationStore.getState()).toEqual(
      expect.objectContaining({ fullscreen: false, pending: false, error: null }),
    );
  });

  it('discards a stale synchronization read when a request starts meanwhile', async () => {
    const syncRead = deferred<boolean>();
    let readCount = 0;
    port.read = async () => {
      readCount += 1;
      return readCount === 1 ? syncRead.promise : true;
    };

    const staleSync = useLyricsPresentationStore.getState().sync();
    const request = useLyricsPresentationStore.getState().request(true);
    await expect(request).resolves.toBe(true);
    syncRead.resolve(false);
    await staleSync;

    expect(useLyricsPresentationStore.getState().fullscreen).toBe(true);
  });

  it('prioritizes escape actions by fullscreen, focus, and lyric visibility', () => {
    expect(lyricsEscapeAction({ lyricsOpen: true, fullscreen: true, focus: true })).toBe(
      'exit-fullscreen',
    );
    expect(lyricsEscapeAction({ lyricsOpen: true, fullscreen: false, focus: true })).toBe(
      'exit-focus',
    );
    expect(lyricsEscapeAction({ lyricsOpen: true, fullscreen: false, focus: false })).toBe(
      'close-lyrics',
    );
    expect(lyricsEscapeAction({ lyricsOpen: false, fullscreen: false, focus: true })).toBe('none');
  });
});

describe('lyric language presentation', () => {
  it('keeps UI language independent from original lyric content', () => {
    expect(shouldShowLyricSecondary('auto', 'Morning light', '晨光', 'translation')).toBe(true);
    expect(shouldShowLyricSecondary('auto', 'chen guang', '晨光', 'romanization')).toBe(true);
    expect(shouldShowLyricSecondary('auto', 'Hello', 'Hello', 'translation')).toBe(false);
  });

  it('honors explicit show and hide preferences', () => {
    expect(shouldShowLyricSecondary('hide', '译文', 'Original', 'translation')).toBe(false);
    expect(shouldShowLyricSecondary('show', 'romanized', 'Original', 'romanization')).toBe(true);
  });
});
