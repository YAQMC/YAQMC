import { describe, expect, it, vi } from 'vitest';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import { LYRICS_LOCKED_ALWAYS_ON_TOP_LEVEL } from './windows-overlay-input';
import { appIndexUrl } from '../protocol';
import {
  clampLyricsSurfaceGeometry,
  createLyricsSurfaceWindow,
  createLyricsSurfaces,
  defaultLyricsSurfaceGeometry,
  geometryOverlapsWorkArea,
  hideLyricsSurface,
  lockLyricsSurface,
  LYRICS_SURFACE_ALWAYS_ON_TOP_LEVEL,
  LYRICS_SURFACE_GEOMETRY,
  LYRICS_SURFACE_GEOMETRY_DEBOUNCE_MS,
  LYRICS_SURFACE_GEOMETRY_PREFIX,
  lyricsSurfaceCreateOptions,
  lyricsSurfaceGeometryKey,
  lyricsSurfaceSettingsFromCore,
  lyricsSurfaceUrl,
  parseLyricsSurfaceGeometry,
  serializeLyricsSurfaceGeometry,
  showLyricsSurface,
  type DisplayWorkArea,
  type LyricsSurfaceClock,
  type LyricsSurfaceCreateOptions,
  type LyricsSurfaceKind,
  type LyricsSurfacePersistedGeometry,
  type LyricsSurfaceSettingsIo,
  type LyricsSurfaceWindow,
} from './lyrics-surfaces';

const PRELOAD = '/tmp/lyrics-surface.cjs';

type MockSurfaceWindow = LyricsSurfaceWindow & {
  bounds: LyricsSurfacePersistedGeometry;
  emit(event: string): void;
};

function mockWindow(
  bounds: LyricsSurfacePersistedGeometry = { x: 0, y: 0, width: 940, height: 190 },
): MockSurfaceWindow {
  const listeners = new Map<string, Array<() => void>>();
  const window: MockSurfaceWindow = {
    bounds: { ...bounds },
    loadURL: vi.fn(),
    show: vi.fn(),
    showInactive: vi.fn(),
    hide: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setFocusable: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setSkipTaskbar: vi.fn(),
    setResizable: vi.fn(),
    isDestroyed: () => false,
    getBounds: vi.fn(() => ({ ...window.bounds })),
    setBounds: vi.fn((next) => {
      window.bounds = { ...window.bounds, ...next };
    }),
    on: vi.fn((event, listener) => {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener as () => void);
      listeners.set(event, bucket);
    }),
    emit(event) {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
  };
  return window;
}

function memorySettings(
  initial: Record<string, string> = {},
): LyricsSurfaceSettingsIo & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async remove(key) {
      store.delete(key);
    },
  };
}

function fakeClock(): LyricsSurfaceClock & { flush(ms: number): void } {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  return {
    setTimeout(callback, ms) {
      const id = ++nextId;
      timers.set(id, { due: now + ms, callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id as number);
    },
    flush(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

const PRIMARY: DisplayWorkArea = { x: 0, y: 0, width: 1920, height: 1040 };
const SECONDARY: DisplayWorkArea = { x: -1920, y: 0, width: 1920, height: 1040 };

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
  it('uses the preserved desktop geometry, not the main 1280×800 window', () => {
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

  it('loads a Vite surface URL when the host supplies a pageUrl override', () => {
    const window = mockWindow();
    createLyricsSurfaceWindow('desktop', {
      preloadPath: PRELOAD,
      pageUrl: (kind) => `http://127.0.0.1:1420/?surface=${kind}`,
      createWindow: () => window,
    });
    expect(window.loadURL).toHaveBeenCalledWith('http://127.0.0.1:1420/?surface=desktop');
  });

  it('uses the preserved island default geometry (Regular 520×156)', () => {
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
  it('show uses showInactive so always-on-top overlays do not steal Fullscreen focus', () => {
    const window = mockWindow();
    showLyricsSurface(window);
    hideLyricsSurface(window);
    expect(window.showInactive).toHaveBeenCalledTimes(1);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.hide).toHaveBeenCalledTimes(1);
  });

  it('falls back to show when showInactive is absent', () => {
    const window = mockWindow();
    delete window.showInactive;
    showLyricsSurface(window);
    expect(window.show).toHaveBeenCalledTimes(1);
  });

  it('lock sets native click-through without forwarding mouse events', () => {
    const window = mockWindow();
    lockLyricsSurface(window, 'desktop', true);
    expect(window.setResizable).toHaveBeenCalledWith(false);
    expect(window.setFocusable).toHaveBeenCalledWith(false);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    expect(window.setIgnoreMouseEvents).not.toHaveBeenCalledWith(true, { forward: true });
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, LYRICS_LOCKED_ALWAYS_ON_TOP_LEVEL);
  });

  it('unlock restores desktop resize and island non-resize', () => {
    const desktop = mockWindow();
    lockLyricsSurface(desktop, 'desktop', false);
    expect(desktop.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
    expect(desktop.setFocusable).toHaveBeenCalledWith(true);
    expect(desktop.setSkipTaskbar).toHaveBeenCalledWith(true);
    expect(desktop.setResizable).toHaveBeenCalledWith(true);
    expect(desktop.setAlwaysOnTop).toHaveBeenCalledWith(true, LYRICS_SURFACE_ALWAYS_ON_TOP_LEVEL);

    const island = mockWindow();
    lockLyricsSurface(island, 'island', false);
    expect(island.setFocusable).toHaveBeenCalledWith(true);
    expect(island.setSkipTaskbar).toHaveBeenCalledWith(true);
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
    expect(island.showInactive).toHaveBeenCalledTimes(1);
    expect(island.show).not.toHaveBeenCalled();
    expect(island.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    expect(island.setFocusable).toHaveBeenCalledWith(false);
    expect(surfaces.get('desktop')).toBe(desktop);
    expect(surfaces.get('island')).toBe(island);
    expect(surfaces.isVisible('desktop')).toBe(false);
    expect(surfaces.isVisible('island')).toBe(true);
    expect(surfaces.isLocked('island')).toBe(true);
    expect(surfaces.isLocked('desktop')).toBe(false);
  });

  it('reapplies native lock after hide/show and notifies overlay bounds', () => {
    const window = mockWindow({ x: 40, y: 80, width: 940, height: 190 });
    const onBoundsChanged = vi.fn();
    const surfaces = createLyricsSurfaces({
      createWindow: () => window,
      preloadPath: PRELOAD,
      onBoundsChanged,
    });
    surfaces.show('desktop');
    surfaces.lock('desktop', true);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    expect(window.setIgnoreMouseEvents).not.toHaveBeenCalledWith(true, { forward: true });
    expect(onBoundsChanged).toHaveBeenCalledWith('desktop', {
      x: 40,
      y: 80,
      width: 940,
      height: 190,
    });

    const ignoreMouse = window.setIgnoreMouseEvents as unknown as {
      mockClear(): void;
      mock: { calls: unknown[][] };
    };
    ignoreMouse.mockClear();
    surfaces.hide('desktop');
    surfaces.show('desktop');
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    expect(surfaces.isLocked('desktop')).toBe(true);

    surfaces.lock('desktop', false);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
    expect(surfaces.isLocked('desktop')).toBe(false);
  });

  it('hide and lock are no-ops until create, and skip destroyed windows', () => {
    const createWindow = vi.fn<(options: LyricsSurfaceCreateOptions) => LyricsSurfaceWindow>(() =>
      mockWindow(),
    );
    const surfaces = createLyricsSurfaces({ createWindow, preloadPath: PRELOAD });
    surfaces.hide('desktop');
    surfaces.lock('island', true);
    expect(createWindow).not.toHaveBeenCalled();

    const window = mockWindow();
    window.isDestroyed = () => true;
    createWindow.mockReturnValueOnce(window);
    surfaces.create('desktop');
    expect(createWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 940,
        height: 190,
        show: false,
        webPreferences: expect.objectContaining({ preload: PRELOAD, sandbox: true }),
      }),
    );
    const created = createWindow.mock.calls[0]?.[0];
    expect(created).toBeDefined();
    expect(created).not.toHaveProperty('x');
    expect(created).not.toHaveProperty('y');
    expect(surfaces.get('desktop')).toBeUndefined();
    surfaces.hide('desktop');
    surfaces.lock('desktop', true);
    expect(window.hide).not.toHaveBeenCalled();
    expect(window.setIgnoreMouseEvents).not.toHaveBeenCalled();
  });
});

describe('BASE-04 geometry keys and JSON blob', () => {
  it('uses stable app_settings keys and camelCase x/y/width/height', () => {
    expect(LYRICS_SURFACE_GEOMETRY_PREFIX).toBe('lyrics-surface-geometry:');
    expect(lyricsSurfaceGeometryKey('desktop')).toBe('lyrics-surface-geometry:desktop');
    expect(lyricsSurfaceGeometryKey('island')).toBe('lyrics-surface-geometry:island');
    expect(LYRICS_SURFACE_GEOMETRY_DEBOUNCE_MS).toBe(350);
    const blob = serializeLyricsSurfaceGeometry({ x: -1800, y: 120, width: 900, height: 180 });
    expect(blob).toBe('{"x":-1800,"y":120,"width":900,"height":180}');
    expect(parseLyricsSurfaceGeometry(blob)).toEqual({
      x: -1800,
      y: 120,
      width: 900,
      height: 180,
    });
  });
});

describe('multi-display clamp', () => {
  it('keeps negative-monitor coordinates that overlap a secondary work area', () => {
    const secondary = { x: -1800, y: 120, width: 900, height: 180 };
    expect(geometryOverlapsWorkArea(secondary, SECONDARY)).toBe(true);
    expect(clampLyricsSurfaceGeometry(secondary, [PRIMARY, SECONDARY], 'desktop')).toEqual({
      x: -1800,
      y: 120,
      width: 900,
      height: 180,
    });
  });

  it('rejects off-screen windows and restores FACT defaults on the primary work area', () => {
    const disconnected = { x: 4000, y: 4000, width: 500, height: 120 };
    expect(geometryOverlapsWorkArea(disconnected, PRIMARY)).toBe(false);
    expect(clampLyricsSurfaceGeometry(disconnected, [PRIMARY], 'desktop')).toEqual(
      defaultLyricsSurfaceGeometry('desktop', PRIMARY),
    );
    expect(defaultLyricsSurfaceGeometry('desktop', PRIMARY)).toMatchObject({
      width: 940,
      height: 190,
    });
    expect(defaultLyricsSurfaceGeometry('island', PRIMARY)).toMatchObject({
      width: 520,
      height: 156,
    });
  });
});

describe('geometry persist, restore, and reset', () => {
  it('restores clamped geometry on create/show using BASE-04 keys', async () => {
    const desktop = mockWindow();
    const settings = memorySettings({
      'lyrics-surface-geometry:desktop': '{"x":80,"y":60,"width":780,"height":190}',
    });
    const surfaces = createLyricsSurfaces({
      preloadPath: PRELOAD,
      createWindow: () => desktop,
      settings,
      getDisplayBounds: () => [PRIMARY],
    });

    surfaces.show('desktop');
    await surfaces.restoreGeometry('desktop');

    expect(desktop.setBounds).toHaveBeenCalledWith({ x: 80, y: 60, width: 780, height: 190 });
    expect(desktop.showInactive).toHaveBeenCalledTimes(1);
    expect(desktop.show).not.toHaveBeenCalled();
  });

  it('reapplies saved geometry after first surface mapping settles', async () => {
    const desktop = mockWindow({ x: 0, y: 0, width: 1920, height: 1040 });
    const settings = memorySettings({
      'lyrics-surface-geometry:desktop': '{"x":80,"y":60,"width":780,"height":190}',
    });
    const clock = fakeClock();
    const surfaces = createLyricsSurfaces({
      preloadPath: PRELOAD,
      createWindow: () => desktop,
      settings,
      clock,
      getDisplayBounds: () => [PRIMARY],
    });

    surfaces.show('desktop');
    await surfaces.restoreGeometry('desktop');
    desktop.bounds = { x: 0, y: 0, width: 1920, height: 1040 };
    clock.flush(LYRICS_SURFACE_GEOMETRY_DEBOUNCE_MS);
    await vi.waitFor(() => {
      expect(desktop.bounds).toEqual({ x: 80, y: 60, width: 780, height: 190 });
    });
  });

  it('debounces move/resize persist at 350 ms and writes the stable JSON blob', async () => {
    const desktop = mockWindow({ x: 10, y: 20, width: 940, height: 190 });
    const settings = memorySettings();
    const clock = fakeClock();
    const surfaces = createLyricsSurfaces({
      preloadPath: PRELOAD,
      createWindow: () => desktop,
      settings,
      clock,
      getDisplayBounds: () => [PRIMARY],
    });

    surfaces.create('desktop');
    await surfaces.restoreGeometry('desktop');
    desktop.bounds = { x: 120, y: 80, width: 800, height: 190 };
    desktop.emit('moved');
    desktop.emit('resized');
    clock.flush(349);
    await Promise.resolve();
    expect(settings.store.size).toBe(0);

    clock.flush(1);
    await Promise.resolve();
    expect(settings.store.get('lyrics-surface-geometry:desktop')).toBe(
      '{"x":120,"y":80,"width":800,"height":190}',
    );
  });

  it('flushGeometry writes current bounds without waiting for the debounce', async () => {
    const desktop = mockWindow({ x: 88, y: 66, width: 780, height: 190 });
    const settings = memorySettings();
    const clock = fakeClock();
    const surfaces = createLyricsSurfaces({
      preloadPath: PRELOAD,
      createWindow: () => desktop,
      settings,
      clock,
      getDisplayBounds: () => [PRIMARY],
    });

    surfaces.create('desktop');
    desktop.bounds = { x: 88, y: 66, width: 780, height: 190 };
    await surfaces.flushGeometry('desktop');
    expect(settings.store.get('lyrics-surface-geometry:desktop')).toBe(
      '{"x":88,"y":66,"width":780,"height":190}',
    );
  });

  it('resetPosition clears the key, applies defaults, and persists', async () => {
    const desktop = mockWindow({ x: 120, y: 80, width: 800, height: 190 });
    const settings = memorySettings({
      'lyrics-surface-geometry:desktop': '{"x":120,"y":80,"width":800,"height":190}',
    });
    const surfaces = createLyricsSurfaces({
      preloadPath: PRELOAD,
      createWindow: () => desktop,
      settings,
      getDisplayBounds: () => [PRIMARY],
    });

    surfaces.create('desktop');
    await surfaces.resetPosition('desktop');

    const expected = defaultLyricsSurfaceGeometry('desktop', PRIMARY);
    expect(desktop.setBounds).toHaveBeenCalledWith(expected);
    expect(settings.store.get('lyrics-surface-geometry:desktop')).toBe(
      serializeLyricsSurfaceGeometry(expected),
    );
  });

  it('maps CoreClient app_settings get/set/remove onto BASE-04 keys', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'app_settings_get') {
        return '{"x":1,"y":2,"width":940,"height":190}';
      }
      return undefined;
    });
    const settings = lyricsSurfaceSettingsFromCore(() => ({ invoke }));
    await expect(settings.get('lyrics-surface-geometry:island')).resolves.toBe(
      '{"x":1,"y":2,"width":940,"height":190}',
    );
    await settings.set('lyrics-surface-geometry:desktop', '{"x":3,"y":4,"width":520,"height":156}');
    await settings.remove('lyrics-surface-geometry:desktop');
    expect(invoke).toHaveBeenCalledWith('app_settings_get', {
      key: 'lyrics-surface-geometry:island',
    });
    expect(invoke).toHaveBeenCalledWith('app_settings_set', {
      key: 'lyrics-surface-geometry:desktop',
      value: '{"x":3,"y":4,"width":520,"height":156}',
    });
    expect(invoke).toHaveBeenCalledWith('app_settings_remove', {
      key: 'lyrics-surface-geometry:desktop',
    });
  });
});

describe('protocol cap', () => {
  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
