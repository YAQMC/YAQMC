import { appIndexUrl } from '../protocol';

export type LyricsSurfaceKind = 'desktop' | 'island';

/** BASE-04 / live Tauri `GEOMETRY_PREFIX` in `lyrics_surface/mod.rs`. */
export const LYRICS_SURFACE_GEOMETRY_PREFIX = 'lyrics-surface-geometry:';

/** Live Tauri `attach_geometry_persistence` debounce. */
export const LYRICS_SURFACE_GEOMETRY_DEBOUNCE_MS = 350;

/**
 * Persisted JSON blob — live Tauri `SurfaceGeometry` (`camelCase` serde):
 * `{ x: i32, y: i32, width: u32, height: u32 }`.
 */
export type LyricsSurfacePersistedGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DisplayWorkArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LyricsSurfaceClock = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

export type LyricsSurfaceSettingsIo = {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

export type LyricsSurfaceCoreClient = {
  invoke(method: string, params?: unknown): Promise<unknown>;
};

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
  getBounds?(): LyricsSurfacePersistedGeometry;
  setBounds?(bounds: Partial<LyricsSurfacePersistedGeometry>): void;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
};

/**
 * Construction table for lyrics-desktop / lyrics-island (§11.2 + live Tauri FACT).
 * `alwaysOnTop: 'screen-saver'` is the intended Electron level; host boot maps
 * this custom field onto `BrowserWindow({ alwaysOnTop: true })` plus
 * `setAlwaysOnTop(true, 'screen-saver')`.
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
  pageUrl?: (kind: LyricsSurfaceKind) => string;
  settings?: LyricsSurfaceSettingsIo;
  clock?: LyricsSurfaceClock;
  getDisplayBounds?: () => readonly DisplayWorkArea[];
  onBoundsChanged?: (kind: LyricsSurfaceKind, geometry: LyricsSurfacePersistedGeometry) => void;
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

const SURFACE_KINDS: readonly LyricsSurfaceKind[] = ['desktop', 'island'];

export function lyricsSurfaceGeometryKey(kind: LyricsSurfaceKind): string {
  return `${LYRICS_SURFACE_GEOMETRY_PREFIX}${kind}`;
}

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
  void window.loadURL(deps.pageUrl?.(kind) ?? lyricsSurfaceUrl(kind));
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
    // True Windows click-through. `{ forward: true }` keeps the surface in the
    // hit-test path so clicks never reach the app underneath (SURF-02).
    window.setIgnoreMouseEvents(true);
    return;
  }
  window.setIgnoreMouseEvents(false);
  window.setFocusable(true);
  window.setResizable(LYRICS_SURFACE_GEOMETRY[kind].resizableWhenUnlocked);
}

export function parseLyricsSurfaceGeometry(
  raw: unknown,
): LyricsSurfacePersistedGeometry | undefined {
  const value = typeof raw === 'string' ? parseJson(raw) : raw;
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const x = asFiniteNumber(record.x);
  const y = asFiniteNumber(record.y);
  const width = asFiniteNumber(record.width);
  const height = asFiniteNumber(record.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  if (width < 1 || height < 1) {
    return undefined;
  }
  return { x, y, width, height };
}

export function serializeLyricsSurfaceGeometry(geometry: LyricsSurfacePersistedGeometry): string {
  return JSON.stringify({
    x: Math.round(geometry.x),
    y: Math.round(geometry.y),
    width: Math.round(geometry.width),
    height: Math.round(geometry.height),
  });
}

/** Live Tauri `geometry_overlaps_work_area`: ≥80×40 overlap, including negative monitor coords. */
export function geometryOverlapsWorkArea(
  geometry: LyricsSurfacePersistedGeometry,
  area: DisplayWorkArea,
): boolean {
  const right = saturatingAdd(geometry.x, geometry.width);
  const bottom = saturatingAdd(geometry.y, geometry.height);
  const areaRight = saturatingAdd(area.x, area.width);
  const areaBottom = saturatingAdd(area.y, area.height);
  const overlapWidth = Math.min(right, areaRight) - Math.max(geometry.x, area.x);
  const overlapHeight = Math.min(bottom, areaBottom) - Math.max(geometry.y, area.y);
  return overlapWidth >= 80 && overlapHeight >= 40;
}

/**
 * Clamp x/y/width/height into a display work area. Off-all-displays uses
 * live Tauri default placement on the primary work area (not the main 1280×800).
 */
export function clampLyricsSurfaceGeometry(
  geometry: LyricsSurfacePersistedGeometry,
  workAreas: readonly DisplayWorkArea[],
  kind: LyricsSurfaceKind,
): LyricsSurfacePersistedGeometry {
  const overlapping = workAreas.find((area) => geometryOverlapsWorkArea(geometry, area));
  const area = overlapping ?? workAreas[0];
  if (!area) {
    return clampToMinimums(geometry, kind);
  }
  if (!overlapping) {
    return defaultLyricsSurfaceGeometry(kind, area);
  }
  return clampToWorkArea(geometry, area, kind);
}

/** Live Tauri `apply_default_geometry` at scale 1 with disabled-config offsets. */
export function defaultLyricsSurfaceGeometry(
  kind: LyricsSurfaceKind,
  area: DisplayWorkArea,
): LyricsSurfacePersistedGeometry {
  const spec = LYRICS_SURFACE_GEOMETRY[kind];
  const width = Math.min(spec.width, Math.max(spec.minWidth, area.width));
  const height = Math.min(spec.height, Math.max(spec.minHeight, area.height));
  const availableX = Math.max(0, area.width - width);
  const normalizedX = 0.5;
  const x = area.x + Math.round(availableX * normalizedX);
  const y = kind === 'island' ? area.y + 24 : area.y + Math.max(0, area.height - height) - 72;
  return clampToWorkArea({ x, y, width, height }, area, kind);
}

export function lyricsSurfaceSettingsFromCore(
  getClient: () => LyricsSurfaceCoreClient | undefined,
): LyricsSurfaceSettingsIo {
  return {
    async get(key) {
      const client = getClient();
      if (!client) {
        return null;
      }
      try {
        const result = await client.invoke('app_settings_get', { key });
        return typeof result === 'string' ? result : null;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      const client = getClient();
      if (!client) {
        return;
      }
      try {
        await client.invoke('app_settings_set', { key, value });
      } catch {
        // Geometry persist is best-effort, matching live Tauri `let _ = storage.set_setting`.
      }
    },
    async remove(key) {
      const client = getClient();
      if (!client) {
        return;
      }
      try {
        await client.invoke('app_settings_remove', { key });
      } catch {
        // Reset still applies in-memory defaults when core is unavailable.
      }
    },
  };
}

export type LyricsSurfaces = {
  create(kind: LyricsSurfaceKind): LyricsSurfaceWindow;
  show(kind: LyricsSurfaceKind): void;
  hide(kind: LyricsSurfaceKind): void;
  lock(kind: LyricsSurfaceKind, locked: boolean): void;
  isLocked(kind: LyricsSurfaceKind): boolean;
  get(kind: LyricsSurfaceKind): LyricsSurfaceWindow | undefined;
  isVisible(kind: LyricsSurfaceKind): boolean;
  restoreGeometry(kind?: LyricsSurfaceKind): Promise<void>;
  resetPosition(kind: LyricsSurfaceKind): Promise<void>;
  /** Write current bounds now (skips the 350 ms debounce). Used by E2E. */
  flushGeometry(kind: LyricsSurfaceKind): Promise<void>;
};

export function createLyricsSurfaces(deps: LyricsSurfaceDeps): LyricsSurfaces {
  const windows = new Map<LyricsSurfaceKind, LyricsSurfaceWindow>();
  const visible = new Set<LyricsSurfaceKind>();
  const locked = new Set<LyricsSurfaceKind>();
  const persistGeneration = new Map<LyricsSurfaceKind, number>();
  const persistTimers = new Map<LyricsSurfaceKind, unknown>();
  const clock = deps.clock ?? {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };

  function live(kind: LyricsSurfaceKind): LyricsSurfaceWindow | undefined {
    const window = windows.get(kind);
    if (!window || window.isDestroyed?.()) {
      return undefined;
    }
    return window;
  }

  function cancelPersist(kind: LyricsSurfaceKind): void {
    const timer = persistTimers.get(kind);
    if (timer !== undefined) {
      clock.clearTimeout(timer);
      persistTimers.delete(kind);
    }
    persistGeneration.set(kind, (persistGeneration.get(kind) ?? 0) + 1);
  }

  function currentBounds(
    kind: LyricsSurfaceKind,
    window: LyricsSurfaceWindow,
  ): LyricsSurfacePersistedGeometry {
    const bounds = window.getBounds?.();
    if (bounds) {
      return clampToMinimums(bounds, kind);
    }
    const spec = LYRICS_SURFACE_GEOMETRY[kind];
    return { x: 0, y: 0, width: spec.width, height: spec.height };
  }

  function applyBounds(
    window: LyricsSurfaceWindow,
    geometry: LyricsSurfacePersistedGeometry,
  ): void {
    window.setBounds?.(geometry);
  }

  function displays(): readonly DisplayWorkArea[] {
    return deps.getDisplayBounds?.() ?? [];
  }

  async function loadGeometry(
    kind: LyricsSurfaceKind,
  ): Promise<LyricsSurfacePersistedGeometry | undefined> {
    if (!deps.settings) {
      return undefined;
    }
    const raw = await deps.settings.get(lyricsSurfaceGeometryKey(kind));
    return parseLyricsSurfaceGeometry(raw);
  }

  async function persistGeometry(
    kind: LyricsSurfaceKind,
    geometry: LyricsSurfacePersistedGeometry,
  ): Promise<void> {
    if (!deps.settings) {
      return;
    }
    await deps.settings.set(
      lyricsSurfaceGeometryKey(kind),
      serializeLyricsSurfaceGeometry(geometry),
    );
  }

  function resolvedGeometry(
    kind: LyricsSurfaceKind,
    saved: LyricsSurfacePersistedGeometry | undefined,
  ): LyricsSurfacePersistedGeometry {
    const areas = displays();
    if (saved) {
      return clampLyricsSurfaceGeometry(saved, areas, kind);
    }
    const primary = areas[0];
    if (primary) {
      return defaultLyricsSurfaceGeometry(kind, primary);
    }
    const spec = LYRICS_SURFACE_GEOMETRY[kind];
    return { x: 0, y: 0, width: spec.width, height: spec.height };
  }

  async function restoreOne(kind: LyricsSurfaceKind, window: LyricsSurfaceWindow): Promise<void> {
    const saved = await loadGeometry(kind);
    if (window.isDestroyed?.()) {
      return;
    }
    applyBounds(window, resolvedGeometry(kind, saved));
    emitBounds(kind, window);
  }

  function emitBounds(kind: LyricsSurfaceKind, window: LyricsSurfaceWindow): void {
    deps.onBoundsChanged?.(kind, currentBounds(kind, window));
  }

  function schedulePersist(kind: LyricsSurfaceKind, window: LyricsSurfaceWindow): void {
    if (!deps.settings) {
      return;
    }
    const current = (persistGeneration.get(kind) ?? 0) + 1;
    persistGeneration.set(kind, current);
    const previous = persistTimers.get(kind);
    if (previous !== undefined) {
      clock.clearTimeout(previous);
    }
    persistTimers.set(
      kind,
      clock.setTimeout(() => {
        persistTimers.delete(kind);
        if (persistGeneration.get(kind) !== current) {
          return;
        }
        if (window.isDestroyed?.()) {
          return;
        }
        void persistGeometry(kind, currentBounds(kind, window));
      }, LYRICS_SURFACE_GEOMETRY_DEBOUNCE_MS),
    );
  }

  function attachPersistence(kind: LyricsSurfaceKind, window: LyricsSurfaceWindow): void {
    if (!window.on) {
      return;
    }
    window.on('moved', () => {
      emitBounds(kind, window);
      schedulePersist(kind, window);
    });
    window.on('resized', () => {
      emitBounds(kind, window);
      schedulePersist(kind, window);
    });
    window.on('closed', () => {
      cancelPersist(kind);
      if (!deps.settings || window.isDestroyed?.()) {
        return;
      }
      void persistGeometry(kind, currentBounds(kind, window));
    });
  }

  function create(kind: LyricsSurfaceKind): LyricsSurfaceWindow {
    const existing = live(kind);
    if (existing) {
      return existing;
    }
    const window = createLyricsSurfaceWindow(kind, deps);
    windows.set(kind, window);
    attachPersistence(kind, window);
    void restoreOne(kind, window);
    return window;
  }

  return {
    create,
    show(kind) {
      visible.add(kind);
      const window = create(kind);
      showLyricsSurface(window);
      if (locked.has(kind)) {
        lockLyricsSurface(window, kind, true);
      }
    },
    hide(kind) {
      visible.delete(kind);
      const window = live(kind);
      if (!window) {
        return;
      }
      hideLyricsSurface(window);
    },
    lock(kind, nextLocked) {
      const window = live(kind);
      if (!window) {
        return;
      }
      if (nextLocked) {
        locked.add(kind);
      } else {
        locked.delete(kind);
      }
      lockLyricsSurface(window, kind, nextLocked);
      emitBounds(kind, window);
    },
    isLocked(kind) {
      return locked.has(kind);
    },
    get(kind) {
      return live(kind);
    },
    isVisible(kind) {
      return visible.has(kind) && live(kind) !== undefined;
    },
    async restoreGeometry(kind) {
      const kinds = kind ? [kind] : SURFACE_KINDS;
      await Promise.all(
        kinds.map(async (next) => {
          const window = live(next);
          if (!window) {
            return;
          }
          await restoreOne(next, window);
        }),
      );
    },
    async resetPosition(kind) {
      cancelPersist(kind);
      if (deps.settings) {
        await deps.settings.remove(lyricsSurfaceGeometryKey(kind));
      }
      const geometry = resolvedGeometry(kind, undefined);
      const window = live(kind);
      if (window) {
        applyBounds(window, geometry);
      }
      await persistGeometry(kind, geometry);
    },
    async flushGeometry(kind) {
      cancelPersist(kind);
      const window = live(kind);
      if (!window) {
        return;
      }
      await persistGeometry(kind, currentBounds(kind, window));
    },
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function saturatingAdd(left: number, right: number): number {
  const sum = Math.round(left) + Math.round(right);
  if (sum > 2147483647) {
    return 2147483647;
  }
  if (sum < -2147483648) {
    return -2147483648;
  }
  return sum;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampToMinimums(
  geometry: LyricsSurfacePersistedGeometry,
  kind: LyricsSurfaceKind,
): LyricsSurfacePersistedGeometry {
  const spec = LYRICS_SURFACE_GEOMETRY[kind];
  return {
    x: Math.round(geometry.x),
    y: Math.round(geometry.y),
    width: Math.max(spec.minWidth, Math.round(geometry.width)),
    height: Math.max(spec.minHeight, Math.round(geometry.height)),
  };
}

function clampToWorkArea(
  geometry: LyricsSurfacePersistedGeometry,
  area: DisplayWorkArea,
  kind: LyricsSurfaceKind,
): LyricsSurfacePersistedGeometry {
  void kind;
  const width = clampNumber(Math.round(geometry.width), 1, Math.max(1, Math.round(area.width)));
  const height = clampNumber(Math.round(geometry.height), 1, Math.max(1, Math.round(area.height)));
  const minX = area.x;
  const minY = area.y;
  const maxX = area.x + area.width - width;
  const maxY = area.y + area.height - height;
  return {
    x: clampNumber(Math.round(geometry.x), minX, Math.max(minX, maxX)),
    y: clampNumber(Math.round(geometry.y), minY, Math.max(minY, maxY)),
    width,
    height,
  };
}
