import type { WindowRole } from '@yaqmc/client';
import {
  BACKGROUND_IMAGE_FILTERS,
  DIAGNOSTICS_ZIP_DEFAULT_NAME,
  DIAGNOSTICS_ZIP_FILTERS,
  pickDirectory,
  pickFile,
  pickSave,
  PLUGIN_PACKAGE_FILTERS,
  type ShowOpenDialog,
  type ShowSaveDialog,
} from '../dialogs';
import { openExternalIfAllowed, type ExternalOpener } from '../open-external';
import {
  LYRICS_SURFACE_GEOMETRY,
  type LyricsSurfaceCreateOptions,
  type LyricsSurfaceKind,
  type LyricsSurfaces,
} from '../windows/lyrics-surfaces';
import {
  type LyricsUnlockKind,
  type LyricsUnlockOverlays,
} from '../windows/lyrics-unlock';
import type { HostHandler } from './router';

/** Not in the 117-command inventory; HostBridge.shell.openExternal lands here. */
export const SHELL_OPEN_EXTERNAL = 'shell.openExternal';

/** Not in the 117-command inventory; diagnostics ZIP save-picker for FE later. */
export const DIALOG_PICK_SAVE = 'dialog.pickSave';

export const PLAYER_INVOKE_METHODS = {
  toggle: 'player_toggle',
  next: 'player_next',
  previous: 'player_previous',
} as const;

export type PlayerInvokeAction = keyof typeof PLAYER_INVOKE_METHODS;

export function playerInvokeMethod(action: PlayerInvokeAction): string {
  return PLAYER_INVOKE_METHODS[action];
}

/**
 * Native Wayland (not XWayland): `WAYLAND_DISPLAY` set and `DISPLAY` unset.
 * Shortcut skip uses this; Chromium flags use `linuxGraphicsSwitches` in Main.
 */
export function isNativeWaylandSession(
  platform: NodeJS.Platform | string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== 'linux') {
    return false;
  }
  return Boolean(env.WAYLAND_DISPLAY) && !env.DISPLAY;
}

/**
 * FACT `close_hides_to_tray`: hide unless `system.closeBehavior === "quit"`.
 * Missing / unreadable prefs default to hide-to-tray.
 */
export function closeToTrayFromPreferences(raw: unknown): boolean {
  if (raw === null || raw === undefined) {
    return true;
  }
  const document = preferencesDocument(raw);
  if (!document?.system || !('closeBehavior' in document.system)) {
    return true;
  }
  return document.system.closeBehavior !== 'quit';
}

export function rememberCloseToTray(raw: unknown, current: boolean): boolean {
  if (typeof raw === 'string' || raw === null) {
    return closeToTrayFromPreferences(raw);
  }
  if (raw && typeof raw === 'object' && 'system' in raw) {
    return closeToTrayFromPreferences(raw);
  }
  return current;
}

function preferencesDocument(
  raw: unknown,
): { system?: { closeBehavior?: unknown } } | undefined {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as { system?: { closeBehavior?: unknown } };
    } catch {
      return undefined;
    }
  }
  if (raw && typeof raw === 'object') {
    return raw as { system?: { closeBehavior?: unknown } };
  }
  return undefined;
}

export function urlFromOpenExternalParams(params: unknown): string {
  if (typeof params === 'string') {
    return params;
  }
  if (params && typeof params === 'object' && 'url' in params) {
    const url = (params as { url: unknown }).url;
    if (typeof url === 'string') {
      return url;
    }
  }
  return '';
}

export function lyricsKindFromParams(params: unknown): LyricsSurfaceKind | undefined {
  if (!params || typeof params !== 'object') {
    return undefined;
  }
  const kind = (params as { kind?: unknown }).kind;
  if (kind === 'desktop' || kind === 'island') {
    return kind;
  }
  return undefined;
}

export function lyricsRoleFromCreateOptions(options: LyricsSurfaceCreateOptions): WindowRole {
  return options.minWidth === LYRICS_SURFACE_GEOMETRY.desktop.minWidth
    ? 'lyrics-desktop'
    : 'lyrics-island';
}

export function lyricsUnlockRoleFromKind(kind: LyricsUnlockKind): WindowRole {
  return kind === 'island' ? 'unlock-island' : 'unlock-desktop';
}

export type PathPickerDialogs = {
  showSaveDialog: ShowSaveDialog;
  showOpenDialog: ShowOpenDialog;
};

function defaultPathFromParams(params: unknown, fallback: string): string {
  if (params && typeof params === 'object' && 'defaultPath' in params) {
    const value = (params as { defaultPath?: unknown }).defaultPath;
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return fallback;
}

export type LyricsSurfaceCapabilities = {
  desktop: boolean;
  island: boolean;
  platform: string;
  backend: string;
  reliableAlwaysOnTop: boolean;
  reliableClickThrough: boolean;
  reliableGlobalPositioning: boolean;
  limitations: string[];
};

export function lyricsSurfaceCapabilities(options: {
  platform: NodeJS.Platform | string;
  nativeWayland: boolean;
}): LyricsSurfaceCapabilities {
  const nativeWayland = options.nativeWayland;
  const backend =
    options.platform !== 'linux'
      ? String(options.platform)
      : nativeWayland
        ? 'wayland-native'
        : 'x11';
  return {
    desktop: true,
    island: true,
    platform: String(options.platform),
    backend,
    reliableAlwaysOnTop: !nativeWayland,
    reliableClickThrough: !nativeWayland,
    reliableGlobalPositioning: !nativeWayland,
    limitations: nativeWayland
      ? [
          'Native Wayland does not guarantee absolute placement, click-through, or always-on-top overlay semantics.',
        ]
      : [],
  };
}

type SurfaceRuntimeLike = {
  enabled?: unknown;
  interaction?: unknown;
};

function asSurfaceRuntimeMap(
  params: unknown,
): { desktop?: SurfaceRuntimeLike; island?: SurfaceRuntimeLike } | undefined {
  if (!params || typeof params !== 'object') {
    return undefined;
  }
  const record = params as { surfaces?: unknown };
  const surfaces =
    record.surfaces && typeof record.surfaces === 'object' ? record.surfaces : params;
  if (!surfaces || typeof surfaces !== 'object') {
    return undefined;
  }
  return surfaces as { desktop?: SurfaceRuntimeLike; island?: SurfaceRuntimeLike };
}

export type HostHandlerDeps = {
  openExternal: ExternalOpener;
  extraHttpsUrls?: () => readonly string[];
  lyrics: LyricsSurfaces;
  unlock: LyricsUnlockOverlays;
  capabilities: () => LyricsSurfaceCapabilities;
  showMainAndOpenSettings: () => void;
  emitSurfaceClosed?: (kind: LyricsSurfaceKind) => void;
  dialogs?: PathPickerDialogs;
};

export function createHostHandlers(deps: HostHandlerDeps): Record<string, HostHandler> {
  const syncUnlockOverlay = (kind: LyricsSurfaceKind, locked: boolean): void => {
    if (locked && deps.lyrics.get(kind) !== undefined) {
      deps.unlock.show(kind);
      return;
    }
    deps.unlock.hide(kind);
  };

  const applyKind = (kind: LyricsSurfaceKind, config: SurfaceRuntimeLike | undefined): void => {
    if (!config || config.enabled !== true) {
      deps.lyrics.hide(kind);
      deps.unlock.hide(kind);
      return;
    }
    deps.lyrics.show(kind);
    const locked = config.interaction === 'passive-locked';
    deps.lyrics.lock(kind, locked);
    syncUnlockOverlay(kind, locked);
  };

  const handlers: Record<string, HostHandler> = {
    [SHELL_OPEN_EXTERNAL]: async (params) => {
      const url = urlFromOpenExternalParams(params);
      return openExternalIfAllowed(deps.openExternal, url, deps.extraHttpsUrls?.() ?? []);
    },
    lyrics_surfaces_reconcile: async (params) => {
      const surfaces = asSurfaceRuntimeMap(params);
      applyKind('desktop', surfaces?.desktop);
      applyKind('island', surfaces?.island);
      return deps.capabilities();
    },
    lyrics_surface_capabilities: async () => deps.capabilities(),
    lyrics_surface_status: async () => ({
      desktop: deps.lyrics.get('desktop') !== undefined,
      island: deps.lyrics.get('island') !== undefined,
    }),
    lyrics_surface_close: async (params) => {
      const kind = lyricsKindFromParams(params);
      if (!kind) {
        return;
      }
      deps.lyrics.hide(kind);
      deps.unlock.hide(kind);
      deps.emitSurfaceClosed?.(kind);
    },
    lyrics_surface_set_interaction: async (params) => {
      const kind = lyricsKindFromParams(params);
      if (!kind) {
        return '';
      }
      const interaction =
        params && typeof params === 'object'
          ? (params as { interaction?: unknown }).interaction
          : undefined;
      const locked = interaction === 'passive-locked';
      deps.lyrics.lock(kind, locked);
      syncUnlockOverlay(kind, locked);
      const value =
        params && typeof params === 'object' ? (params as { value?: unknown }).value : undefined;
      return typeof value === 'string' ? value : '';
    },
    lyrics_surface_show_settings: async () => {
      deps.showMainAndOpenSettings();
    },
    lyrics_surface_unlock: async (params) => {
      const kind = lyricsKindFromParams(params);
      if (!kind) {
        return;
      }
      deps.lyrics.lock(kind, false);
      deps.unlock.hide(kind);
    },
    lyrics_surfaces_unlock_all: async () => {
      let unlocked = 0;
      for (const kind of ['desktop', 'island'] as const) {
        if (deps.lyrics.get(kind) === undefined) {
          deps.unlock.hide(kind);
          continue;
        }
        deps.lyrics.lock(kind, false);
        deps.unlock.hide(kind);
        unlocked += 1;
      }
      return unlocked;
    },
    lyrics_surface_reset_position: async (params) => {
      const kind = lyricsKindFromParams(params);
      if (!kind) {
        return;
      }
      await deps.lyrics.resetPosition(kind);
    },
  };

  if (deps.dialogs) {
    const { showSaveDialog, showOpenDialog } = deps.dialogs;
    handlers.appearance_pick_background = async () => {
      const chosen = await pickFile(showOpenDialog, { filters: BACKGROUND_IMAGE_FILTERS });
      return chosen === null ? null : { reference: chosen, dataUri: '' };
    };
    handlers.plugin_pick_package = async () =>
      pickFile(showOpenDialog, { filters: PLUGIN_PACKAGE_FILTERS });
    handlers.plugin_pick_directory = async () => pickDirectory(showOpenDialog);
    handlers[DIALOG_PICK_SAVE] = async (params) =>
      pickSave(showSaveDialog, {
        filters: DIAGNOSTICS_ZIP_FILTERS,
        defaultPath: defaultPathFromParams(params, DIAGNOSTICS_ZIP_DEFAULT_NAME),
      });
  }

  return handlers;
}
