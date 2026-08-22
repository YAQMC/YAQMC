import { appIndexUrl } from '../protocol';
import {
  applyUnlockOverlayInput,
  showOverlayInactive,
  type OverlayInputWindow,
} from './windows-overlay-input';

export type LyricsUnlockKind = 'desktop' | 'island';

/** Injected window seam so unit tests never construct a real Electron `BrowserWindow`. */
export type LyricsUnlockWindow = OverlayInputWindow & {
  loadURL(url: string): Promise<void> | void;
  show(): void;
  showInactive?(): void;
  hide(): void;
  setBounds?(bounds: { x: number; y: number; width: number; height: number }): void;
  isDestroyed?(): boolean;
};

/**
 * Construction table for lyrics-desktop-unlock / lyrics-island-unlock (§11.2 contract).
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
  createWindow: (options: LyricsUnlockCreateOptions, kind: LyricsUnlockKind) => LyricsUnlockWindow;
  preloadPath?: string;
  pageUrl?: (kind: LyricsUnlockKind) => string;
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
 * Preserved default create geometry:
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
/** Stable unlock-window inset (logical px). */
export const LYRICS_UNLOCK_INSET = 14;

export type UnlockOverlayBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Place the pill at the surface's top-right. */
export function unlockOverlayBounds(surface: UnlockOverlayBounds): UnlockOverlayBounds {
  return {
    x: surface.x + surface.width - LYRICS_UNLOCK_GEOMETRY.width - LYRICS_UNLOCK_INSET,
    y: surface.y + LYRICS_UNLOCK_INSET,
    width: LYRICS_UNLOCK_GEOMETRY.width,
    height: LYRICS_UNLOCK_GEOMETRY.height,
  };
}

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
  window.setAlwaysOnTop?.(true, LYRICS_UNLOCK_ALWAYS_ON_TOP_LEVEL);
  void window.loadURL(deps.pageUrl?.(kind) ?? lyricsUnlockUrl(kind));
  return window;
}

export function showLyricsUnlock(window: LyricsUnlockWindow): void {
  applyUnlockOverlayInput(window, LYRICS_UNLOCK_ALWAYS_ON_TOP_LEVEL);
  showOverlayInactive(window);
  window.moveTop?.();
}

export function hideLyricsUnlock(window: LyricsUnlockWindow): void {
  window.hide();
}

export type LyricsUnlockOverlays = {
  create(kind: LyricsUnlockKind): LyricsUnlockWindow;
  show(kind: LyricsUnlockKind): void;
  hide(kind: LyricsUnlockKind): void;
  position(kind: LyricsUnlockKind, surface: UnlockOverlayBounds): void;
  get(kind: LyricsUnlockKind): LyricsUnlockWindow | undefined;
};

export function createLyricsUnlockOverlays(deps: LyricsUnlockDeps): LyricsUnlockOverlays {
  const windows = new Map<LyricsUnlockKind, LyricsUnlockWindow>();
  const visible = new Set<LyricsUnlockKind>();

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
      const existing = windows.get(kind);
      if (visible.has(kind) && existing && existing.isDestroyed?.() !== true) {
        return;
      }
      visible.add(kind);
      showLyricsUnlock(create(kind));
    },
    hide(kind) {
      if (!visible.delete(kind)) {
        return;
      }
      const window = windows.get(kind);
      if (!window || window.isDestroyed?.()) {
        return;
      }
      hideLyricsUnlock(window);
    },
    position(kind, surface) {
      const window = windows.get(kind);
      if (!window || window.isDestroyed?.()) {
        return;
      }
      window.setBounds?.(unlockOverlayBounds(surface));
      window.moveTop?.();
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
