import { appIndexUrl } from '../protocol';

export type LyricsUnlockKind = 'desktop' | 'island';

/** Injected window seam so unit tests never construct a real Electron `BrowserWindow`. */
export type LyricsUnlockWindow = {
  loadURL(url: string): Promise<void> | void;
  show(): void;
  hide(): void;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  isDestroyed?(): boolean;
};

/**
 * Construction table for lyrics-desktop-unlock / lyrics-island-unlock (§11.2 + live Tauri FACT).
 * `alwaysOnTop: 'screen-saver'` is the intended Electron level; host boot maps
 * this custom field onto `BrowserWindow({ alwaysOnTop: true })` plus
 * `setAlwaysOnTop(true, 'screen-saver')`.
 *
 * Preload is a path string only. SURF-05 owns `preload/unlock-overlay.ts`; the
 * default here is a relative `unlock-overlay.cjs` filename, not a file we create.
 */
export type LyricsUnlockCreateOptions = {
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
  frame: false;
  transparent: true;
  alwaysOnTop: 'screen-saver';
  skipTaskbar: true;
  resizable: false;
  focusable: false;
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

export type LyricsUnlockDeps = {
  createWindow: (
    options: LyricsUnlockCreateOptions,
    kind: LyricsUnlockKind,
  ) => LyricsUnlockWindow;
  preloadPath?: string;
};

export type LyricsUnlockGeometry = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
};

/**
 * Default create geometry from live Tauri `lyrics_surface/mod.rs` `build_unlock_window`:
 * inner/min/max 42×42. Same pill for desktop and island.
 */
export const LYRICS_UNLOCK_GEOMETRY: LyricsUnlockGeometry = {
  width: 42,
  height: 42,
  minWidth: 42,
  minHeight: 42,
  maxWidth: 42,
  maxHeight: 42,
};

export const LYRICS_UNLOCK_TITLE = 'Unlock YAQMC Lyrics';
export const LYRICS_UNLOCK_ALWAYS_ON_TOP_LEVEL = 'screen-saver' as const;
export const DEFAULT_UNLOCK_OVERLAY_PRELOAD = 'unlock-overlay.cjs';

export function lyricsUnlockLabel(kind: LyricsUnlockKind): string {
  return kind === 'desktop' ? 'lyrics-desktop-unlock' : 'lyrics-island-unlock';
}

export function lyricsUnlockUrl(kind: LyricsUnlockKind): string {
  return appIndexUrl(`?unlockSurface=${kind}`);
}

export function lyricsUnlockPreloadPath(preloadPath?: string): string {
  return preloadPath ?? DEFAULT_UNLOCK_OVERLAY_PRELOAD;
}

export function lyricsUnlockCreateOptions(
  preloadPath: string = DEFAULT_UNLOCK_OVERLAY_PRELOAD,
): LyricsUnlockCreateOptions {
  return {
    title: LYRICS_UNLOCK_TITLE,
    width: LYRICS_UNLOCK_GEOMETRY.width,
    height: LYRICS_UNLOCK_GEOMETRY.height,
    minWidth: LYRICS_UNLOCK_GEOMETRY.minWidth,
    minHeight: LYRICS_UNLOCK_GEOMETRY.minHeight,
    maxWidth: LYRICS_UNLOCK_GEOMETRY.maxWidth,
    maxHeight: LYRICS_UNLOCK_GEOMETRY.maxHeight,
    frame: false,
    transparent: true,
    alwaysOnTop: LYRICS_UNLOCK_ALWAYS_ON_TOP_LEVEL,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
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

export function createLyricsUnlockWindow(
  kind: LyricsUnlockKind,
  deps: LyricsUnlockDeps,
): LyricsUnlockWindow {
  const window = deps.createWindow(
    lyricsUnlockCreateOptions(lyricsUnlockPreloadPath(deps.preloadPath)),
    kind,
  );
  window.setAlwaysOnTop(true, LYRICS_UNLOCK_ALWAYS_ON_TOP_LEVEL);
  void window.loadURL(lyricsUnlockUrl(kind));
  return window;
}

export function showLyricsUnlock(window: LyricsUnlockWindow): void {
  window.show();
}

export function hideLyricsUnlock(window: LyricsUnlockWindow): void {
  window.hide();
}

export type LyricsUnlockOverlays = {
  create(kind: LyricsUnlockKind): LyricsUnlockWindow;
  show(kind: LyricsUnlockKind): void;
  hide(kind: LyricsUnlockKind): void;
  get(kind: LyricsUnlockKind): LyricsUnlockWindow | undefined;
};

export function createLyricsUnlockOverlays(deps: LyricsUnlockDeps): LyricsUnlockOverlays {
  const windows = new Map<LyricsUnlockKind, LyricsUnlockWindow>();

  function create(kind: LyricsUnlockKind): LyricsUnlockWindow {
    const existing = windows.get(kind);
    if (existing && existing.isDestroyed?.() !== true) {
      return existing;
    }
    const window = createLyricsUnlockWindow(kind, deps);
    windows.set(kind, window);
    return window;
  }

  return {
    create,
    show(kind) {
      showLyricsUnlock(create(kind));
    },
    hide(kind) {
      const window = windows.get(kind);
      if (!window || window.isDestroyed?.()) {
        return;
      }
      hideLyricsUnlock(window);
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
