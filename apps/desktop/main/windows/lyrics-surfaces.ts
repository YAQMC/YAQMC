import { appIndexUrl } from '../protocol';

export type LyricsSurfaceKind = 'desktop' | 'island';

/** Injected window seam so unit tests never construct a real Electron `BrowserWindow`. */
export type LyricsSurfaceWindow = {
  loadURL(url: string): Promise<void> | void;
  show(): void;
  hide(): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void;
  setFocusable(focusable: boolean): void;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  setResizable(resizable: boolean): void;
  isDestroyed?(): boolean;
};

/**
 * Construction table for lyrics-desktop / lyrics-island (§11.2 + live Tauri FACT).
 * `alwaysOnTop: 'screen-saver'` is the intended Electron level; the later wire-up
 * maps this custom field onto `BrowserWindow({ alwaysOnTop: true })` plus
 * `setAlwaysOnTop(true, 'screen-saver')`. This module stays unwired from `index.ts`.
 */
export type LyricsSurfaceCreateOptions = {
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  frame: false;
  transparent: true;
  alwaysOnTop: 'screen-saver';
  skipTaskbar: true;
  resizable: boolean;
  focusable: boolean;
  show: false;
  hasShadow: false;
  webPreferences: {
    preload: string;
    sandbox: true;
    contextIsolation: true;
    nodeIntegration: false;
    webSecurity: true;
    allowRunningInsecureContent: false;
    experimentalFeatures: false;
    spellcheck: false;
    backgroundThrottling: false;
  };
};

export type LyricsSurfaceDeps = {
  createWindow: (options: LyricsSurfaceCreateOptions) => LyricsSurfaceWindow;
  preloadPath: string;
};

export type LyricsSurfaceGeometry = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  resizableWhenUnlocked: boolean;
};

/**
 * Default create geometry from live Tauri `lyrics_surface/mod.rs` `logical_dimensions`
 * + `SurfaceRuntimeConfig::disabled` (desktop Wide, island Regular) and
 * `WebviewWindowBuilder` min sizes. Not the main window's 1280×800.
 */
export const LYRICS_SURFACE_GEOMETRY: Record<LyricsSurfaceKind, LyricsSurfaceGeometry> = {
  desktop: {
    width: 940,
    height: 190,
    minWidth: 460,
    minHeight: 190,
    resizableWhenUnlocked: true,
  },
  island: {
    width: 520,
    height: 156,
    minWidth: 520,
    minHeight: 156,
    resizableWhenUnlocked: false,
  },
};

export const LYRICS_SURFACE_TITLE = 'YAQMC Lyrics';
export const LYRICS_SURFACE_ALWAYS_ON_TOP_LEVEL = 'screen-saver' as const;

export function lyricsSurfaceUrl(kind: LyricsSurfaceKind): string {
  return appIndexUrl(`?surface=${kind}`);
}

export function lyricsSurfaceCreateOptions(
  kind: LyricsSurfaceKind,
  preloadPath: string,
): LyricsSurfaceCreateOptions {
  const geometry = LYRICS_SURFACE_GEOMETRY[kind];
  return {
    title: LYRICS_SURFACE_TITLE,
    width: geometry.width,
    height: geometry.height,
    minWidth: geometry.minWidth,
    minHeight: geometry.minHeight,
    frame: false,
    transparent: true,
    alwaysOnTop: LYRICS_SURFACE_ALWAYS_ON_TOP_LEVEL,
    skipTaskbar: true,
    resizable: geometry.resizableWhenUnlocked,
    focusable: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  };
}

export function createLyricsSurfaceWindow(
  kind: LyricsSurfaceKind,
  deps: LyricsSurfaceDeps,
): LyricsSurfaceWindow {
  const window = deps.createWindow(lyricsSurfaceCreateOptions(kind, deps.preloadPath));
  window.setAlwaysOnTop(true, LYRICS_SURFACE_ALWAYS_ON_TOP_LEVEL);
  void window.loadURL(lyricsSurfaceUrl(kind));
  return window;
}

export function showLyricsSurface(window: LyricsSurfaceWindow): void {
  window.show();
}

export function hideLyricsSurface(window: LyricsSurfaceWindow): void {
  window.hide();
}

/**
 * Lock: click-through + not focusable (plan §22.2). Unlock overlays are SURF-02.
 * Call order matches Tauri `apply_window_interaction`: lock sets resizable/focusable
 * before ignore-cursor; unlock reverses cursor first.
 */
export function lockLyricsSurface(
  window: LyricsSurfaceWindow,
  kind: LyricsSurfaceKind,
  locked: boolean,
): void {
  if (locked) {
    window.setResizable(false);
    window.setFocusable(false);
    window.setIgnoreMouseEvents(true, { forward: true });
    return;
  }
  window.setIgnoreMouseEvents(false);
  window.setFocusable(true);
  window.setResizable(LYRICS_SURFACE_GEOMETRY[kind].resizableWhenUnlocked);
}

export type LyricsSurfaces = {
  create(kind: LyricsSurfaceKind): LyricsSurfaceWindow;
  show(kind: LyricsSurfaceKind): void;
  hide(kind: LyricsSurfaceKind): void;
  lock(kind: LyricsSurfaceKind, locked: boolean): void;
  get(kind: LyricsSurfaceKind): LyricsSurfaceWindow | undefined;
};

export function createLyricsSurfaces(deps: LyricsSurfaceDeps): LyricsSurfaces {
  const windows = new Map<LyricsSurfaceKind, LyricsSurfaceWindow>();

  function create(kind: LyricsSurfaceKind): LyricsSurfaceWindow {
    const existing = windows.get(kind);
    if (existing && existing.isDestroyed?.() !== true) {
      return existing;
    }
    const window = createLyricsSurfaceWindow(kind, deps);
    windows.set(kind, window);
    return window;
  }

  return {
    create,
    show(kind) {
      showLyricsSurface(create(kind));
    },
    hide(kind) {
      const window = windows.get(kind);
      if (!window || window.isDestroyed?.()) {
        return;
      }
      hideLyricsSurface(window);
    },
    lock(kind, locked) {
      const window = windows.get(kind);
      if (!window || window.isDestroyed?.()) {
        return;
      }
      lockLyricsSurface(window, kind, locked);
    },
    get(kind) {
      const window = windows.get(kind);
      if (!window || window.isDestroyed?.()) {
        return undefined;
      }
      return window;
    },
  };
}
