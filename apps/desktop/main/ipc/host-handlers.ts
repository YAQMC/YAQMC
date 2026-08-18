import type {
  AccountLoginMethod,
  CoreStatusPayload,
  DiagnosticsHostPayload,
  OAuthPrepareResult,
  WindowRole,
} from '@yaqmc/client';
import { attachHostPayloadToExportParams } from '../diagnostics-host-payload';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  BACKGROUND_IMAGE_FILTERS,
  DIAGNOSTICS_ZIP_DEFAULT_NAME,
  DIAGNOSTICS_ZIP_FILTERS,
  pickDirectory,
  pickFile,
  pickSave,
  PLUGIN_PACKAGE_FILTERS,
  resolveDiagnosticsSavePath,
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
import {
  openOAuthWindow,
  type OAuthWindowCreateOptions,
  type OAuthWindowLike,
} from '../windows/oauth-window';
import type { HostHandler } from './router';

/** Not in the 117-command inventory; HostBridge.shell.openExternal lands here. */
export const SHELL_OPEN_EXTERNAL = 'shell.openExternal';

/** Not in the 117-command inventory; HostBridge.window lands here. */
export const WINDOW_MINIMIZE = 'window.minimize';
export const WINDOW_TOGGLE_MAXIMIZE = 'window.toggleMaximize';
export const WINDOW_CLOSE = 'window.close';
export const WINDOW_SET_FULLSCREEN = 'window.setFullscreen';

/** Host-only probe so the renderer can markReady if it missed host://core-status. */
export const HOST_CORE_STATUS = 'host.coreStatus';

/** Not in the 117-command inventory; diagnostics ZIP save-picker for FE later. */
export const DIALOG_PICK_SAVE = 'dialog.pickSave';

/** Inventory host-owned methods. Not `shell.openExternal`. */
export const DIAGNOSTICS_OPEN_LOG_FOLDER = 'diagnostics_open_log_folder';
export const DIAGNOSTICS_REVEAL_BUNDLE = 'diagnostics_reveal_bundle';

/** Host-only; not in METHOD_NAMES. Settings Check for updates. */
export const HOST_UPDATER_CHECK_METHOD = 'host_updater_check';
export const HOST_UPDATER_DOWNLOAD_METHOD = 'host_updater_download';
export const HOST_UPDATER_INSTALL_METHOD = 'host_updater_install';

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

export type OAuthHostDeps = {
  createWindow: (options: OAuthWindowCreateOptions) => OAuthWindowLike;
  fromPartition: (partition: string, options?: { cache: boolean }) => unknown;
  isPackaged: boolean;
  invoke: (method: string, params?: unknown) => Promise<unknown>;
};

export function loginProviderFromParams(params: unknown): AccountLoginMethod | undefined {
  if (!params || typeof params !== 'object') {
    return undefined;
  }
  const loginProvider = (params as { loginProvider?: unknown }).loginProvider;
  if (loginProvider === 'qq' || loginProvider === 'wechat') {
    return loginProvider;
  }
  return undefined;
}

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

export type CoreInvoke = (
  method: string,
  params?: unknown,
  origin?: string,
) => Promise<unknown>;

export type HostUpdaterDeps = {
  check: () => Promise<unknown>;
  download: () => Promise<unknown>;
  install: () => Promise<unknown>;
};

export type HostWindowChrome = {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  setFullscreen(enabled: boolean): void;
};

export type HostWindowChromeLookup = (webContentsId: number) => HostWindowChrome | undefined;

export type HostFolderOpener = {
  logDir: () => string;
  openPath: (target: string) => Promise<string>;
  showItemInFolder: (target: string) => void;
  exists: (target: string) => boolean;
};

export function isPathInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function pathFromParams(params: unknown): string {
  if (typeof params === 'string') {
    return params;
  }
  if (params && typeof params === 'object' && 'path' in params) {
    const value = (params as { path?: unknown }).path;
    if (typeof value === 'string') {
      return value;
    }
  }
  return '';
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
  downloadsDir?: () => string;
  folders?: HostFolderOpener;
  oauth?: OAuthHostDeps;
  coreInvoke?: CoreInvoke;
  collectHostPayload?: () => DiagnosticsHostPayload;
  updater?: HostUpdaterDeps;
  windowChrome?: HostWindowChromeLookup;
  coreStatus?: () => CoreStatusPayload;
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
    handlers[DIALOG_PICK_SAVE] = async (params) => {
      const downloads = deps.downloadsDir?.() ?? '';
      const chosen = await pickSave(showSaveDialog, {
        filters: DIAGNOSTICS_ZIP_FILTERS,
        defaultPath: resolveDiagnosticsSavePath(
          defaultPathFromParams(params, DIAGNOSTICS_ZIP_DEFAULT_NAME),
          downloads,
        ),
      });
      if (chosen === null) {
        return null;
      }
      return resolveDiagnosticsSavePath(chosen, downloads);
    };
  }

  if (deps.folders) {
    const folders = deps.folders;
    handlers[DIAGNOSTICS_OPEN_LOG_FOLDER] = async () => {
      const logDir = folders.logDir();
      if (logDir.length === 0) {
        throw new Error('log directory is not configured');
      }
      mkdirSync(logDir, { recursive: true });
      const opened = await folders.openPath(logDir);
      if (opened.length > 0) {
        throw new Error(opened);
      }
      return logDir;
    };
    handlers[DIAGNOSTICS_REVEAL_BUNDLE] = async (params) => {
      const target = pathFromParams(params);
      if (target.length === 0 || !path.isAbsolute(target)) {
        throw new Error('diagnostics_reveal_bundle requires an absolute path');
      }
      const resolved = path.resolve(target);
      const logDir = folders.logDir();
      const allowed =
        (logDir.length > 0 && isPathInside(logDir, resolved)) ||
        (resolved.toLowerCase().endsWith('.zip') && folders.exists(resolved));
      if (!allowed) {
        throw new Error('path is outside the log directory and is not an existing zip');
      }
      folders.showItemInFolder(resolved);
    };
  }

  if (deps.coreInvoke && deps.collectHostPayload) {
    const invokeWithHostPayload = async (
      method: string,
      params: unknown,
      origin?: string,
    ): Promise<unknown> => {
      let hostPayload: DiagnosticsHostPayload | undefined;
      try {
        hostPayload = deps.collectHostPayload?.();
      } catch {
        hostPayload = undefined;
      }
      const next = hostPayload
        ? attachHostPayloadToExportParams(params, hostPayload)
        : params;
      return deps.coreInvoke!(method, next, origin);
    };
    handlers.diagnostics_export_bundle = async (params, _webContentsId, origin) =>
      invokeWithHostPayload('diagnostics_export_bundle', params, origin);
    handlers.diagnostics_export_bundle_to = async (params, _webContentsId, origin) => {
      const record = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
      const rawPath = typeof record.path === 'string' ? record.path : '';
      const next =
        rawPath.length > 0
          ? {
              ...record,
              path: resolveDiagnosticsSavePath(rawPath, deps.downloadsDir?.() ?? ''),
            }
          : params;
      return invokeWithHostPayload('diagnostics_export_bundle_to', next, origin);
    };
  }

  if (deps.updater) {
    const updater = deps.updater;
    handlers[HOST_UPDATER_CHECK_METHOD] = async () => updater.check();
    handlers[HOST_UPDATER_DOWNLOAD_METHOD] = async () => updater.download();
    handlers[HOST_UPDATER_INSTALL_METHOD] = async () => updater.install();
  }

  if (deps.windowChrome) {
    const chromeFor = (webContentsId: number | undefined): HostWindowChrome | undefined => {
      if (webContentsId === undefined) {
        return undefined;
      }
      return deps.windowChrome?.(webContentsId);
    };
    handlers[WINDOW_MINIMIZE] = async (_params, webContentsId) => {
      chromeFor(webContentsId)?.minimize();
    };
    handlers[WINDOW_TOGGLE_MAXIMIZE] = async (_params, webContentsId) => {
      chromeFor(webContentsId)?.toggleMaximize();
    };
    handlers[WINDOW_CLOSE] = async (_params, webContentsId) => {
      chromeFor(webContentsId)?.close();
    };
    handlers[WINDOW_SET_FULLSCREEN] = async (params, webContentsId) => {
      const enabled =
        params !== null &&
        typeof params === 'object' &&
        (params as { enabled?: unknown }).enabled === true;
      chromeFor(webContentsId)?.setFullscreen(enabled);
    };
  }

  if (deps.coreStatus) {
    handlers[HOST_CORE_STATUS] = async () => deps.coreStatus!();
  }

  if (deps.oauth) {
    const oauth = deps.oauth;
    handlers.qqmusic_auth_oauth_start = async (params) => {
      const loginProvider = loginProviderFromParams(params);
      if (!loginProvider) {
        throw new Error('qqmusic_auth_oauth_start requires loginProvider');
      }
      await openOAuthWindow(loginProvider, {
        createWindow: oauth.createWindow,
        fromPartition: oauth.fromPartition,
        isPackaged: oauth.isPackaged,
        auth_oauth_prepare: (prepareParams) =>
          oauth.invoke('auth_oauth_prepare', prepareParams) as Promise<OAuthPrepareResult>,
        auth_oauth_complete: (completeParams) => oauth.invoke('auth_oauth_complete', completeParams),
        auth_oauth_cancel: (cancelParams) => oauth.invoke('auth_oauth_cancel', cancelParams),
      });
      return oauth.invoke('qqmusic_account_snapshot');
    };
  }

  return handlers;
}
