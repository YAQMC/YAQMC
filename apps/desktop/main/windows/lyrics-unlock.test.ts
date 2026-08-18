import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import { appIndexUrl } from '../protocol';
import {
  createLyricsUnlockOverlays,
  createLyricsUnlockWindow,
  DEFAULT_UNLOCK_OVERLAY_PRELOAD,
  hideLyricsUnlock,
  LYRICS_UNLOCK_ALWAYS_ON_TOP_LEVEL,
  LYRICS_UNLOCK_GEOMETRY,
  lyricsUnlockCreateOptions,
  lyricsUnlockLabel,
  lyricsUnlockPreloadPath,
  lyricsUnlockUrl,
  showLyricsUnlock,
  type LyricsUnlockCreateOptions,
  type LyricsUnlockKind,
  type LyricsUnlockWindow,
} from './lyrics-unlock';

const PRELOAD = '/tmp/unlock-overlay.cjs';

function mockWindow(): LyricsUnlockWindow {
  return {
    loadURL: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    isDestroyed: () => false,
  };
}

function createWithFactory(kind: LyricsUnlockKind, preloadPath?: string): {
  window: LyricsUnlockWindow;
  options: LyricsUnlockCreateOptions;
} {
  let options: LyricsUnlockCreateOptions | undefined;
  const window = mockWindow();
  createLyricsUnlockWindow(kind, {
    ...(preloadPath === undefined ? {} : { preloadPath }),
    createWindow: (next) => {
      options = next;
      return window;
    },
  });
  if (!options) {
    throw new Error('createWindow was not called');
  }
  return { window, options };
}

describe('lyrics unlock overlay construction table', () => {
  it('uses live Tauri 42×42 pill geometry for both kinds', () => {
    expect(LYRICS_UNLOCK_GEOMETRY).toEqual({
      width: 42,
      height: 42,
      minWidth: 42,
      minHeight: 42,
      maxWidth: 42,
      maxHeight: 42,
    });
    const { options, window } = createWithFactory('desktop', PRELOAD);
    expect(options).toMatchObject({
      title: 'Unlock YAQMC Lyrics',
      width: 42,
      height: 42,
      minWidth: 42,
      minHeight: 42,
      maxWidth: 42,
      maxHeight: 42,
      frame: false,
      transparent: true,
      alwaysOnTop: 'screen-saver',
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      show: false,
      hasShadow: false,
    });
    expect(options.alwaysOnTop).toBe(LYRICS_UNLOCK_ALWAYS_ON_TOP_LEVEL);
    expect(options.webPreferences).toEqual({
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      backgroundThrottling: false,
    });
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
    expect(window.loadURL).toHaveBeenCalledWith(appIndexUrl('?unlockSurface=desktop'));
    expect(lyricsUnlockUrl('desktop')).toBe('app://yaqmc/index.html?unlockSurface=desktop');
    expect(lyricsUnlockLabel('desktop')).toBe('lyrics-desktop-unlock');
  });

  it('loads a Vite unlock URL when the host supplies a pageUrl override', () => {
    const window = mockWindow();
    createLyricsUnlockWindow('island', {
      preloadPath: PRELOAD,
      pageUrl: (kind) => `http://127.0.0.1:1420/?unlockSurface=${kind}`,
      createWindow: () => window,
    });
    expect(window.loadURL).toHaveBeenCalledWith('http://127.0.0.1:1420/?unlockSurface=island');
  });

  it('loads the island overlay with the same pill size and unlockSurface query', () => {
    const { options, window } = createWithFactory('island', PRELOAD);
    expect(options.width).toBe(42);
    expect(options.height).toBe(42);
    expect(options.maxWidth).toBe(42);
    expect(window.loadURL).toHaveBeenCalledWith(appIndexUrl('?unlockSurface=island'));
    expect(lyricsUnlockUrl('island')).toBe('app://yaqmc/index.html?unlockSurface=island');
    expect(lyricsUnlockLabel('island')).toBe('lyrics-island-unlock');
    expect(lyricsUnlockUrl('desktop')).not.toMatch(/[?&]surface=/);
  });

  it('defaults the preload option to a relative unlock-overlay.cjs filename', () => {
    expect(DEFAULT_UNLOCK_OVERLAY_PRELOAD).toBe('unlock-overlay.cjs');
    expect(lyricsUnlockPreloadPath()).toBe('unlock-overlay.cjs');
    expect(lyricsUnlockPreloadPath(PRELOAD)).toBe(PRELOAD);
    const options = lyricsUnlockCreateOptions();
    expect(options.webPreferences.preload).toBe('unlock-overlay.cjs');
    const { options: created } = createWithFactory('desktop');
    expect(created.webPreferences.preload).toBe('unlock-overlay.cjs');
  });
});

describe('show / hide helpers', () => {
  it('show and hide call through the injected window', () => {
    const window = mockWindow();
    showLyricsUnlock(window);
    hideLyricsUnlock(window);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.hide).toHaveBeenCalledTimes(1);
  });
});

describe('createLyricsUnlockOverlays controller', () => {
  it('creates each kind once, then show/hide the stored window without a display', () => {
    const desktop = mockWindow();
    const island = mockWindow();
    const createWindow = vi.fn();
    createWindow.mockReturnValueOnce(desktop);
    createWindow.mockReturnValue(island);

    const overlays = createLyricsUnlockOverlays({ createWindow, preloadPath: PRELOAD });

    expect(overlays.create('desktop')).toBe(desktop);
    expect(overlays.create('desktop')).toBe(desktop);
    overlays.show('island');
    overlays.hide('desktop');

    expect(createWindow).toHaveBeenCalledTimes(2);
    expect(desktop.hide).toHaveBeenCalledTimes(1);
    expect(island.show).toHaveBeenCalledTimes(1);
    expect(overlays.get('desktop')).toBe(desktop);
    expect(overlays.get('island')).toBe(island);
    expect(createWindow.mock.calls[0]?.[0].show).toBe(false);
  });

  it('hide is a no-op until create, and skips destroyed windows', () => {
    const createWindow = vi.fn(mockWindow);
    const overlays = createLyricsUnlockOverlays({ createWindow });
    overlays.hide('desktop');
    expect(createWindow).not.toHaveBeenCalled();

    const window = mockWindow();
    window.isDestroyed = () => true;
    createWindow.mockReturnValueOnce(window);
    overlays.create('desktop');
    expect(overlays.get('desktop')).toBeUndefined();
    overlays.hide('desktop');
    expect(window.hide).not.toHaveBeenCalled();
  });
});

describe('unwired status', () => {
  it('is imported from Main index.ts', () => {
    const index = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.ts'),
      'utf8',
    );
    expect(index).toContain('lyrics-unlock');
    expect(index).toContain('unlock-overlay.cjs');
    expect(index).toContain('createLyricsUnlockOverlays');
  });
});

describe('protocol cap', () => {
  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
