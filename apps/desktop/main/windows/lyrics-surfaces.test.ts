import { describe, expect, it, vi } from 'vitest';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import { appIndexUrl } from '../protocol';
import {
  createLyricsSurfaceWindow,
  createLyricsSurfaces,
  hideLyricsSurface,
  lockLyricsSurface,
  LYRICS_SURFACE_ALWAYS_ON_TOP_LEVEL,
  LYRICS_SURFACE_GEOMETRY,
  lyricsSurfaceCreateOptions,
  lyricsSurfaceUrl,
  showLyricsSurface,
  type LyricsSurfaceCreateOptions,
  type LyricsSurfaceKind,
  type LyricsSurfaceWindow,
} from './lyrics-surfaces';

const PRELOAD = '/tmp/lyrics-surface.cjs';

function mockWindow(): LyricsSurfaceWindow {
  return {
    loadURL: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setFocusable: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setResizable: vi.fn(),
    isDestroyed: () => false,
  };
}

function createWithFactory(kind: LyricsSurfaceKind): {
  window: LyricsSurfaceWindow;
  options: LyricsSurfaceCreateOptions;
} {
  let options: LyricsSurfaceCreateOptions | undefined;
  const window = mockWindow();
  createLyricsSurfaceWindow(kind, {
    preloadPath: PRELOAD,
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

describe('lyrics surface construction table', () => {
  it('uses live Tauri desktop geometry, not the main 1280×800 window', () => {
    expect(LYRICS_SURFACE_GEOMETRY.desktop).toEqual({
      width: 940,
      height: 190,
      minWidth: 460,
      minHeight: 190,
      resizableWhenUnlocked: true,
    });
    const { options, window } = createWithFactory('desktop');
    expect(options).toMatchObject({
      title: 'YAQMC Lyrics',
      width: 940,
      height: 190,
      minWidth: 460,
      minHeight: 190,
      frame: false,
      transparent: true,
      alwaysOnTop: 'screen-saver',
      skipTaskbar: true,
      resizable: true,
      focusable: true,
      show: false,
      hasShadow: false,
    });
    expect(options.width).not.toBe(1280);
    expect(options.height).not.toBe(800);
    expect(options.alwaysOnTop).toBe(LYRICS_SURFACE_ALWAYS_ON_TOP_LEVEL);
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
    expect(window.loadURL).toHaveBeenCalledWith(appIndexUrl('?surface=desktop'));
    expect(lyricsSurfaceUrl('desktop')).toBe('app://yaqmc/index.html?surface=desktop');
  });

  it('uses live Tauri island default geometry (Regular 520×156)', () => {
    expect(LYRICS_SURFACE_GEOMETRY.island).toEqual({
      width: 520,
      height: 156,
      minWidth: 520,
      minHeight: 156,
      resizableWhenUnlocked: false,
    });
    const { options, window } = createWithFactory('island');
    expect(options).toMatchObject({
      width: 520,
      height: 156,
      minWidth: 520,
      minHeight: 156,
      frame: false,
      transparent: true,
      alwaysOnTop: 'screen-saver',
      skipTaskbar: true,
      resizable: false,
      show: false,
    });
    expect(options.width).not.toBe(1280);
    expect(window.loadURL).toHaveBeenCalledWith(appIndexUrl('?surface=island'));
    expect(lyricsSurfaceUrl('island')).toBe('app://yaqmc/index.html?surface=island');
    expect(lyricsSurfaceUrl('island')).not.toContain('unlockSurface');
  });

  it('does not construct unlock overlay windows', () => {
    const options = lyricsSurfaceCreateOptions('desktop', PRELOAD);
    expect(JSON.stringify(options)).not.toContain('unlock');
    expect(lyricsSurfaceUrl('desktop')).not.toContain('unlock');
    expect(lyricsSurfaceUrl('island')).not.toContain('unlock');
  });
});

describe('show / hide / lock helpers', () => {
  it('show and hide call through the injected window', () => {
    const window = mockWindow();
    showLyricsSurface(window);
    hideLyricsSurface(window);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.hide).toHaveBeenCalledTimes(1);
  });

  it('lock sets click-through with forward and is not focusable', () => {
    const window = mockWindow();
    lockLyricsSurface(window, 'desktop', true);
    expect(window.setResizable).toHaveBeenCalledWith(false);
    expect(window.setFocusable).toHaveBeenCalledWith(false);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
  });

  it('unlock restores desktop resize and island non-resize', () => {
    const desktop = mockWindow();
    lockLyricsSurface(desktop, 'desktop', false);
    expect(desktop.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
    expect(desktop.setFocusable).toHaveBeenCalledWith(true);
    expect(desktop.setResizable).toHaveBeenCalledWith(true);

    const island = mockWindow();
    lockLyricsSurface(island, 'island', false);
    expect(island.setFocusable).toHaveBeenCalledWith(true);
    expect(island.setResizable).toHaveBeenCalledWith(false);
  });
});

describe('createLyricsSurfaces controller', () => {
  it('creates each kind once, then show/hide/lock the stored window', () => {
    const desktop = mockWindow();
    const island = mockWindow();
    const createWindow = vi.fn((options: LyricsSurfaceCreateOptions) => {
      return options.width === 940 ? desktop : island;
    });
    const surfaces = createLyricsSurfaces({ createWindow, preloadPath: PRELOAD });

    expect(surfaces.create('desktop')).toBe(desktop);
    expect(surfaces.create('desktop')).toBe(desktop);
    surfaces.show('island');
    surfaces.hide('desktop');
    surfaces.lock('island', true);

    expect(createWindow).toHaveBeenCalledTimes(2);
    expect(desktop.hide).toHaveBeenCalledTimes(1);
    expect(island.show).toHaveBeenCalledTimes(1);
    expect(island.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    expect(island.setFocusable).toHaveBeenCalledWith(false);
    expect(surfaces.get('desktop')).toBe(desktop);
    expect(surfaces.get('island')).toBe(island);
  });

  it('hide and lock are no-ops until create, and skip destroyed windows', () => {
    const createWindow = vi.fn(mockWindow);
    const surfaces = createLyricsSurfaces({ createWindow, preloadPath: PRELOAD });
    surfaces.hide('desktop');
    surfaces.lock('island', true);
    expect(createWindow).not.toHaveBeenCalled();

    const window = mockWindow();
    window.isDestroyed = () => true;
    createWindow.mockReturnValueOnce(window);
    surfaces.create('desktop');
    expect(surfaces.get('desktop')).toBeUndefined();
    surfaces.hide('desktop');
    surfaces.lock('desktop', true);
    expect(window.hide).not.toHaveBeenCalled();
    expect(window.setIgnoreMouseEvents).not.toHaveBeenCalled();
  });
});

describe('protocol cap', () => {
  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
