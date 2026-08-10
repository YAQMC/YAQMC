import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialPlayerState, usePlayerStore } from './player-store';
import {
  setFullscreenPortForTests,
  useLyricsPresentationStore,
  type FullscreenPort,
} from './lyrics-presentation';
import {
  closeLyricsPresentation,
  enterLyricsFullscreen,
  exitLyricsFullscreen,
  runAfterLyricsClose,
  toggleQueueAfterLyricsClose,
} from './lyrics-presentation-actions';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeFullscreenPort implements FullscreenPort {
  fullscreen = false;
  writes: boolean[] = [];
  failWrite = false;

  async read() {
    return this.fullscreen;
  }

  async write(value: boolean) {
    this.writes.push(value);
    if (this.failWrite) throw new Error('native fullscreen denial');
    this.fullscreen = value;
  }

  async subscribe() {
    return () => undefined;
  }
}

describe('lyrics presentation actions', () => {
  let port: FakeFullscreenPort;
  let restorePort: () => void;

  beforeEach(() => {
    usePlayerStore.setState(initialPlayerState);
    port = new FakeFullscreenPort();
    restorePort = setFullscreenPortForTests(port);
  });

  afterEach(() => restorePort());

  it('opens Lyrics and closes Queue before fullscreen entry begins', async () => {
    usePlayerStore.setState({ queueOpen: true, lyricsOpen: false });
    port.write = async (value) => {
      port.writes.push(value);
      expect(usePlayerStore.getState()).toMatchObject({ queueOpen: false, lyricsOpen: true });
      port.fullscreen = value;
    };

    await expect(enterLyricsFullscreen()).resolves.toBe(true);

    expect(port.writes).toEqual([true]);
  });

  it('keeps Lyrics visible with presentation error when entry is rejected', async () => {
    port.failWrite = true;

    await expect(enterLyricsFullscreen()).resolves.toBe(false);

    expect(usePlayerStore.getState().lyricsOpen).toBe(true);
    expect(useLyricsPresentationStore.getState()).toEqual(
      expect.objectContaining({
        fullscreen: false,
        pending: false,
        error: 'native fullscreen denial',
      }),
    );
  });

  it('closes immediately in normal mode and clears a stale presentation error', async () => {
    usePlayerStore.setState({ lyricsOpen: true });
    useLyricsPresentationStore.setState({ error: 'obsolete native error' });

    await expect(closeLyricsPresentation()).resolves.toBe(true);

    expect(port.writes).toEqual([]);
    expect(usePlayerStore.getState().lyricsOpen).toBe(false);
    expect(useLyricsPresentationStore.getState().error).toBeNull();
  });

  it('exits confirmed fullscreen before closing Lyrics', async () => {
    port.fullscreen = true;
    usePlayerStore.setState({ lyricsOpen: true });
    useLyricsPresentationStore.setState({ fullscreen: true });

    await expect(closeLyricsPresentation()).resolves.toBe(true);

    expect(port.writes).toEqual([false]);
    expect(useLyricsPresentationStore.getState()).toEqual(
      expect.objectContaining({ fullscreen: false, pending: false, error: null }),
    );
    expect(usePlayerStore.getState().lyricsOpen).toBe(false);
  });

  it('keeps Lyrics open after a rejected exit even when false is confirmed', async () => {
    port.failWrite = true;
    usePlayerStore.setState({ lyricsOpen: true });
    useLyricsPresentationStore.setState({ fullscreen: true });

    await expect(closeLyricsPresentation()).resolves.toBe(false);

    expect(useLyricsPresentationStore.getState()).toEqual(
      expect.objectContaining({
        fullscreen: false,
        pending: false,
        error: 'native fullscreen denial',
      }),
    );
    expect(usePlayerStore.getState().lyricsOpen).toBe(true);
  });

  it('serializes a pending entry followed by exit before closing Lyrics', async () => {
    const entryGate = deferred<void>();
    port.write = async (value) => {
      port.writes.push(value);
      if (value) await entryGate.promise;
      port.fullscreen = value;
    };
    usePlayerStore.setState({ lyricsOpen: true });

    const entry = useLyricsPresentationStore.getState().request(true);
    await Promise.resolve();
    expect(useLyricsPresentationStore.getState().pending).toBe(true);
    const close = closeLyricsPresentation();

    entryGate.resolve();
    await expect(Promise.all([entry, close])).resolves.toEqual([false, true]);

    expect(port.writes).toEqual([true, false]);
    expect(useLyricsPresentationStore.getState()).toEqual(
      expect.objectContaining({ fullscreen: false, pending: false, error: null }),
    );
    expect(usePlayerStore.getState().lyricsOpen).toBe(false);
  });

  it('coalesces concurrent closes into one exit request and one shared promise', async () => {
    const exitGate = deferred<void>();
    port.fullscreen = true;
    port.write = async (value) => {
      port.writes.push(value);
      await exitGate.promise;
      port.fullscreen = value;
    };
    usePlayerStore.setState({ lyricsOpen: true });
    useLyricsPresentationStore.setState({ fullscreen: true });

    const firstClose = closeLyricsPresentation();
    const secondClose = closeLyricsPresentation();

    expect(secondClose).toBe(firstClose);
    await Promise.resolve();
    expect(port.writes).toEqual([false]);
    expect(usePlayerStore.getState().lyricsOpen).toBe(true);

    exitGate.resolve();
    await expect(Promise.all([firstClose, secondClose])).resolves.toEqual([true, true]);
    expect(port.writes).toEqual([false]);
  });

  it('does not run a gated action when fullscreen exit is rejected', async () => {
    const action = vi.fn();
    port.failWrite = true;
    port.fullscreen = true;
    usePlayerStore.setState({ lyricsOpen: true });
    useLyricsPresentationStore.setState({ fullscreen: true });

    await expect(runAfterLyricsClose(action)).resolves.toBe(false);

    expect(action).not.toHaveBeenCalled();
    expect(usePlayerStore.getState()).toMatchObject({ lyricsOpen: true, queueOpen: false });
    expect(useLyricsPresentationStore.getState().error).toBe('native fullscreen denial');
  });

  it('opens Queue only after a confirmed Lyrics close', async () => {
    port.failWrite = true;
    port.fullscreen = true;
    usePlayerStore.setState({ lyricsOpen: true });
    useLyricsPresentationStore.setState({ fullscreen: true });

    await expect(toggleQueueAfterLyricsClose()).resolves.toBe(false);

    expect(usePlayerStore.getState()).toMatchObject({ lyricsOpen: true, queueOpen: false });
    expect(useLyricsPresentationStore.getState().error).toBe('native fullscreen denial');
  });

  it('preserves direct Queue toggle-close when Queue is already open', async () => {
    usePlayerStore.setState({ queueOpen: true, lyricsOpen: false });

    await expect(toggleQueueAfterLyricsClose()).resolves.toBe(true);

    expect(port.writes).toEqual([]);
    expect(usePlayerStore.getState()).toMatchObject({ queueOpen: false, lyricsOpen: false });
  });

  it('requests an explicit exit instead of toggling from a fresh fullscreen snapshot', async () => {
    useLyricsPresentationStore.setState({ fullscreen: false });

    await expect(exitLyricsFullscreen()).resolves.toBe(false);

    expect(port.writes).toEqual([false]);
    expect(useLyricsPresentationStore.getState().fullscreen).toBe(false);
  });
});
