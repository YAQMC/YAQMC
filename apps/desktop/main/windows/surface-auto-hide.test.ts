import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CHANNEL_HOST_COMMAND, FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import {
  applySurfaceAutoHide,
  handleSurfaceHostCommand,
  parseHostCommandPayload,
  subscribeSurfaceAutoHide,
  surfaceAutoHideListener,
  type SurfaceAutoHideTarget,
} from './surface-auto-hide';
import {
  createLyricsSurfaces,
  LYRICS_SURFACE_GEOMETRY,
  LYRICS_SURFACE_GEOMETRY_DEBOUNCE_MS,
  type LyricsSurfaceCreateOptions,
  type LyricsSurfaceKind,
  type LyricsSurfacePersistedGeometry,
  type LyricsSurfaceWindow,
} from './lyrics-surfaces';

type MockSurfaceWindow = LyricsSurfaceWindow & {
  bounds: LyricsSurfacePersistedGeometry;
};

function mockWindow(
  bounds: LyricsSurfacePersistedGeometry = { x: 0, y: 0, width: 940, height: 190 },
): MockSurfaceWindow {
  const window: MockSurfaceWindow = {
    bounds: { ...bounds },
    loadURL: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setFocusable: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setResizable: vi.fn(),
    isDestroyed: () => false,
    getBounds: vi.fn(() => ({ ...window.bounds })),
    setBounds: vi.fn((next) => {
      window.bounds = { ...window.bounds, ...next };
    }),
    on: vi.fn(),
  };
  return window;
}

function mockSurfaces(options?: {
  enabled?: Partial<Record<LyricsSurfaceKind, boolean>>;
  hideInFullscreen?: Partial<Record<LyricsSurfaceKind, boolean>>;
}): SurfaceAutoHideTarget & {
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  windows: Map<LyricsSurfaceKind, object>;
} {
  const windows = new Map<LyricsSurfaceKind, object>();
  const visible = new Set<LyricsSurfaceKind>();
  return {
    windows,
    show: vi.fn((kind: LyricsSurfaceKind) => {
      windows.set(kind, { kind });
      visible.add(kind);
    }),
    hide: vi.fn((kind: LyricsSurfaceKind) => {
      visible.delete(kind);
    }),
    get: (kind) => windows.get(kind) as never,
    isVisible: (kind) => visible.has(kind),
    enabled: options?.enabled
      ? (kind) => options.enabled?.[kind] !== false
      : undefined,
    hideInFullscreen: options?.hideInFullscreen
      ? (kind) => options.hideInFullscreen?.[kind] !== false
      : undefined,
  };
}

describe('parseHostCommandPayload', () => {
  it('accepts plan §22.2 surfaceAutoHide and protocol raise/quit', () => {
    expect(parseHostCommandPayload({ surfaceAutoHide: true })).toEqual({
      kind: 'surfaceAutoHide',
      hidden: true,
    });
    expect(parseHostCommandPayload({ surfaceAutoHide: false })).toEqual({
      kind: 'surfaceAutoHide',
      hidden: false,
    });
    expect(parseHostCommandPayload({ command: 'raise' })).toEqual({ kind: 'raise' });
    expect(parseHostCommandPayload({ command: 'quit' })).toEqual({ kind: 'quit' });
  });

  it('unwraps a host://command event frame', () => {
    expect(
      parseHostCommandPayload({
        kind: 'event',
        seq: 7,
        channel: CHANNEL_HOST_COMMAND,
        payload: { surfaceAutoHide: true },
      }),
    ).toEqual({ kind: 'surfaceAutoHide', hidden: true });
    expect(
      parseHostCommandPayload({
        kind: 'event',
        seq: 7,
        channel: CHANNEL_HOST_COMMAND,
        payload: { command: 'raise' },
      }),
    ).toEqual({ kind: 'raise' });
  });

  it('ignores unknown payloads', () => {
    expect(parseHostCommandPayload(undefined)).toBeUndefined();
    expect(parseHostCommandPayload(null)).toBeUndefined();
    expect(parseHostCommandPayload({})).toBeUndefined();
    expect(parseHostCommandPayload({ command: 'nope' })).toBeUndefined();
    expect(parseHostCommandPayload({ surfaceAutoHide: 'yes' })).toBeUndefined();
  });
});

describe('applySurfaceAutoHide', () => {
  it('hides desktop and island without destroying them, then restores visibility', () => {
    const desktop = mockWindow();
    const island = mockWindow({ x: 0, y: 0, width: 520, height: 156 });
    const createWindow = vi.fn((options: LyricsSurfaceCreateOptions) => {
      return options.width === 940 ? desktop : island;
    });
    const surfaces = createLyricsSurfaces({ createWindow, preloadPath: '/tmp/preload.cjs' });
    surfaces.show('desktop');
    surfaces.show('island');
    expect(surfaces.isVisible('desktop')).toBe(true);
    expect(surfaces.isVisible('island')).toBe(true);

    applySurfaceAutoHide(surfaces, true);

    expect(desktop.hide).toHaveBeenCalledTimes(1);
    expect(island.hide).toHaveBeenCalledTimes(1);
    expect(surfaces.get('desktop')).toBe(desktop);
    expect(surfaces.get('island')).toBe(island);
    expect(desktop.isDestroyed?.()).toBe(false);
    expect(island.isDestroyed?.()).toBe(false);
    expect(createWindow).toHaveBeenCalledTimes(2);

    applySurfaceAutoHide(surfaces, false);

    expect(desktop.show).toHaveBeenCalledTimes(2);
    expect(island.show).toHaveBeenCalledTimes(2);
    expect(surfaces.get('desktop')).toBe(desktop);
    expect(createWindow).toHaveBeenCalledTimes(2);
  });

  it('restores only surfaces that were visible before hide', () => {
    const surfaces = mockSurfaces();
    surfaces.show('desktop');

    applySurfaceAutoHide(surfaces, true);
    expect(surfaces.hide).toHaveBeenCalledWith('desktop');
    expect(surfaces.hide).toHaveBeenCalledWith('island');

    surfaces.hide.mockClear();
    surfaces.show.mockClear();
    applySurfaceAutoHide(surfaces, false);

    expect(surfaces.show).toHaveBeenCalledWith('desktop');
    expect(surfaces.show).not.toHaveBeenCalledWith('island');
  });

  it('keeps the first visibility snapshot across duplicate hide commands', () => {
    const surfaces = mockSurfaces();
    surfaces.show('island');
    applySurfaceAutoHide(surfaces, true);
    applySurfaceAutoHide(surfaces, true);
    surfaces.show.mockClear();
    applySurfaceAutoHide(surfaces, false);
    expect(surfaces.show).toHaveBeenCalledWith('island');
    expect(surfaces.show).not.toHaveBeenCalledWith('desktop');
  });

  it('skips a kind when enabled is false or hideInFullscreen is false', () => {
    const skipped = mockSurfaces({
      enabled: { desktop: false, island: true },
      hideInFullscreen: { desktop: true, island: false },
    });
    skipped.show('desktop');
    skipped.show('island');
    applySurfaceAutoHide(skipped, true);
    expect(skipped.hide).not.toHaveBeenCalled();
  });
});

describe('subscribeSurfaceAutoHide', () => {
  it('hides on host://command payloads and on event frames, ignoring raise/quit', () => {
    const surfaces = mockSurfaces();
    surfaces.show('desktop');
    surfaces.show('island');
    const client = new EventEmitter();
    const unsubscribe = subscribeSurfaceAutoHide(client, surfaces);

    client.emit(CHANNEL_HOST_COMMAND, { command: 'raise' });
    client.emit(CHANNEL_HOST_COMMAND, { command: 'quit' });
    expect(surfaces.hide).not.toHaveBeenCalled();

    client.emit(CHANNEL_HOST_COMMAND, { surfaceAutoHide: true });
    expect(surfaces.hide).toHaveBeenCalledWith('desktop');
    expect(surfaces.hide).toHaveBeenCalledWith('island');

    surfaces.hide.mockClear();
    surfaces.show.mockClear();
    client.emit('event', {
      kind: 'event',
      seq: 8,
      channel: CHANNEL_HOST_COMMAND,
      payload: { surfaceAutoHide: false },
    });
    expect(surfaces.show).toHaveBeenCalledWith('desktop');
    expect(surfaces.show).toHaveBeenCalledWith('island');

    unsubscribe();
    surfaces.hide.mockClear();
    client.emit(CHANNEL_HOST_COMMAND, { surfaceAutoHide: true });
    client.emit('event', {
      channel: CHANNEL_HOST_COMMAND,
      payload: { surfaceAutoHide: true },
    });
    expect(surfaces.hide).not.toHaveBeenCalled();
  });

  it('exports a listener that can be attached to host://command', () => {
    const surfaces = mockSurfaces();
    surfaces.show('desktop');
    const client = new EventEmitter();
    const listener = surfaceAutoHideListener(surfaces);
    client.on(CHANNEL_HOST_COMMAND, listener);
    handleSurfaceHostCommand(surfaces, { command: 'raise' });
    expect(surfaces.hide).not.toHaveBeenCalled();
    client.emit(CHANNEL_HOST_COMMAND, { surfaceAutoHide: true });
    expect(surfaces.hide).toHaveBeenCalledWith('desktop');
    expect(surfaces.hide).toHaveBeenCalledWith('island');
  });
});

describe('SURF-03 geometry and protocol cap stay', () => {
  it('keeps 350 ms debounce, BASE-04 sizes, and the 32 MiB cap', () => {
    expect(LYRICS_SURFACE_GEOMETRY_DEBOUNCE_MS).toBe(350);
    expect(LYRICS_SURFACE_GEOMETRY.desktop).toMatchObject({ width: 940, height: 190 });
    expect(LYRICS_SURFACE_GEOMETRY.island).toMatchObject({ width: 520, height: 156 });
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
