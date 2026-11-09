import type {
  AccountLoginMethod,
  CoreStatusPayload,
  DeepLinkRegistrationStatus,
  DiagnosticsHostPayload,
  OAuthPrepareResult,
  OpenCatalogSongPayload,
  WindowRole,
} from '@yaqmc/client';
import { attachHostPayloadToExportParams } from '../diagnostics-host-payload';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  DIAGNOSTICS_ZIP_DEFAULT_NAME,
  filtersFor,
  pickDirectory,
  pickFile,
  pickSave,
  resolveDiagnosticsSavePath,
  resolveStatisticsSavePath,
  type PathPickerKind,
  type ShowOpenDialog,
  type ShowSaveDialog,
} from '../dialogs';
import { hydrateManagedBackground } from '../managed-background';
import { openExternalIfAllowed, type ExternalOpener } from '../open-external';
import {
  desktopIntegrationFromFacts,
  overlayPlatformDiagnostics,
  type HostPlatformFacts,
} from '../platform-diagnostics';
import {
  LYRICS_SURFACE_GEOMETRY,
  type LyricsSurfaceCreateOptions,
  type LyricsSurfaceKind,
  type LyricsSurfaces,
} from '../windows/lyrics-surfaces';
import { type LyricsUnlockKind, type LyricsUnlockOverlays } from '../windows/lyrics-unlock';
import {
  openOAuthWindow,
  openProviderOAuthWindow,
  type OAuthWindowCreateOptions,
  type OAuthWindowLike,
} from '../windows/oauth-window';
import type { HostHandler } from './router';

/** Not in the migrated Core inventory; HostBridge.shell.openExternal lands here. */
export const SHELL_OPEN_EXTERNAL = 'shell.openExternal';

/** Main-process clipboard write; renderer clipboard permissions remain denied. */
export const CLIPBOARD_WRITE_TEXT = 'clipboard.writeText';

/** Not in the migrated Core inventory; HostBridge.window lands here. */
export const WINDOW_MINIMIZE = 'window.minimize';
export const WINDOW_TOGGLE_MAXIMIZE = 'window.toggleMaximize';
export const WINDOW_CLOSE = 'window.close';
export const WINDOW_SET_FULLSCREEN = 'window.setFullscreen';

/** Host-only probe so the renderer can markReady if it missed host://core-status. */
export const HOST_CORE_STATUS = 'host.coreStatus';

/** Not in the protocol inventory; diagnostics ZIP save-picker for the renderer. */
export const DIALOG_PICK_SAVE = 'dialog.pickSave';
/** Not in the protocol inventory; typed open-file picker for renderer continuations. */
export const DIALOG_PICK_FILE = 'dialog.pickFile';

/** Inventory host-owned methods. Not `shell.openExternal`. */
export const DIAGNOSTICS_OPEN_LOG_FOLDER = 'diagnostics_open_log_folder';
export const DIAGNOSTICS_REVEAL_BUNDLE = 'diagnostics_reveal_bundle';
export const SYSTEM_SHORTCUTS_SET_ENABLED = 'system_shortcuts_set_enabled';

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

function preferencesDocument(raw: unknown): { system?: { closeBehavior?: unknown } } | undefined {
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

const MAX_CLIPBOARD_TEXT_BYTES = 16 * 1024;

export function textFromClipboardParams(params: unknown): string {
  const text =
    params && typeof params === 'object' && 'text' in params
      ? (params as { text?: unknown }).text
      : undefined;
  if (
    typeof text !== 'string' ||
    text.length === 0 ||
    text.includes('\0') ||
    new TextEncoder().encode(text).length > MAX_CLIPBOARD_TEXT_BYTES
  ) {
    throw new Error('clipboard.writeText requires bounded non-empty text');
  }
  return text;
}

export function enabledFromParams(params: unknown): boolean {
  return (
    params !== null &&
    typeof params === 'object' &&
    (params as { enabled?: unknown }).enabled === true
  );
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

export function providerOAuthFromParams(
  params: unknown,
): { providerId: string; methodId: string; profileId?: string } | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const { providerId, methodId, profileId } = params as {
    providerId?: unknown;
    methodId?: unknown;
    profileId?: unknown;
  };
  const validId = (value: unknown) =>
    typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value);
  return validId(providerId) && validId(methodId) && (profileId === undefined || validId(profileId))
    ? {
        providerId: providerId as string,
        methodId: methodId as string,
        ...(profileId === undefined ? {} : { profileId: profileId as string }),
      }
    : undefined;
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

function openFileKindFromParams(
  params: unknown,
): Extract<PathPickerKind, 'background-image' | 'plugin-package'> {
  const kind =
    params && typeof params === 'object' && 'kind' in params
      ? (params as { kind?: unknown }).kind
      : undefined;
  if (kind === 'background-image' || kind === 'plugin-package') {
    return kind;
  }
  throw new Error('dialog.pickFile requires a supported kind');
}

function saveFileKindFromParams(
  params: unknown,
): Extract<PathPickerKind, 'diagnostics-zip' | 'statistics-json' | 'statistics-csv'> {
  const kind =
    params && typeof params === 'object' && 'kind' in params
      ? (params as { kind?: unknown }).kind
      : undefined;
  if (kind === undefined || kind === 'diagnostics-zip') return 'diagnostics-zip';
  if (kind === 'statistics-json' || kind === 'statistics-csv') return kind;
  throw new Error('dialog.pickSave requires a supported kind');
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
  nativeWayland?: boolean;
  displayBackend?: string;
}): LyricsSurfaceCapabilities {
  const platform = String(options.platform);
  if (platform !== 'linux') {
    return {
      desktop: true,
      island: true,
      platform,
      backend: platform,
      reliableAlwaysOnTop: true,
      reliableClickThrough: true,
      reliableGlobalPositioning: true,
      limitations: [],
    };
  }

  const backend = options.displayBackend ?? (options.nativeWayland ? 'wayland-native' : 'x11');
  const nativeWayland =
    backend === 'wayland-native' || backend === 'wayland' || backend === 'native-wayland';
  if (nativeWayland) {
    return {
      desktop: true,
      island: true,
      platform,
      backend: backend === 'wayland' ? 'wayland-native' : backend,
      reliableAlwaysOnTop: false,
      reliableClickThrough: false,
      reliableGlobalPositioning: false,
      limitations: [
        'Native Wayland does not guarantee absolute placement, click-through, or always-on-top overlay semantics.',
      ],
    };
  }

  if (backend === 'xwayland') {
    return {
      desktop: true,
      island: true,
      platform,
      backend: 'xwayland',
      reliableAlwaysOnTop: true,
      reliableClickThrough: true,
      reliableGlobalPositioning: true,
      limitations: [
        'The desktop session is Wayland, but YAQMC is using an X11/XWayland window backend.',
      ],
    };
  }

  return {
    desktop: true,
    island: true,
    platform,
    backend,
    reliableAlwaysOnTop: true,
    reliableClickThrough: true,
    reliableGlobalPositioning: true,
    limitations: [],
  };
}

type SurfaceInteractionName = 'interactive' | 'passive-locked';

function asSurfaceInteraction(value: unknown): SurfaceInteractionName | undefined {
  if (value === 'interactive' || value === 'passive-locked') {
    return value;
  }
  return undefined;
}

function patchSurfaceInteractionDocument(
  raw: string,
  kind: LyricsSurfaceKind,
  interaction: SurfaceInteractionName,
): string | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const surfaces =
      parsed.surfaces && typeof parsed.surfaces === 'object'
        ? { ...(parsed.surfaces as Record<string, unknown>) }
        : {};
    const current =
      surfaces[kind] && typeof surfaces[kind] === 'object'
        ? { ...(surfaces[kind] as Record<string, unknown>) }
        : {};
    current.interaction = interaction;
    surfaces[kind] = current;
    parsed.surfaces = surfaces;
    return JSON.stringify(parsed);
  } catch {
    return undefined;
  }
}

function originMayControlKind(origin: string | undefined, kind: LyricsSurfaceKind): boolean {
  if (origin === undefined || origin === 'host' || origin === 'main') {
    return true;
  }
  if (origin === 'lyrics-desktop') {
    return kind === 'desktop';
  }
  if (origin === 'lyrics-island') {
    return kind === 'island';
  }
  return false;
}

function originMayUnlockKind(origin: string | undefined, kind: LyricsSurfaceKind): boolean {
  if (origin === undefined || origin === 'host' || origin === 'main') {
    return true;
  }
  if (origin === 'lyrics-desktop-unlock') {
    return kind === 'desktop';
  }
  if (origin === 'lyrics-island-unlock') {
    return kind === 'island';
  }
  return false;
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

export type CoreInvoke = (method: string, params?: unknown, origin?: string) => Promise<unknown>;

export type HostUpdaterDeps = {
  check: () => Promise<unknown>;
  download: () => Promise<unknown>;
  install: () => Promise<unknown>;
  start?: (candidateId: string) => Promise<unknown>;
  status?: () => unknown;
  cancel?: () => Promise<unknown>;
  preferences?: (includePrerelease: boolean) => Promise<unknown>;
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
  writeClipboardText?: (text: string) => void | Promise<void>;
  extraHttpsUrls?: () => readonly string[];
  lyrics: LyricsSurfaces;
  unlock: LyricsUnlockOverlays;
  capabilities: () => LyricsSurfaceCapabilities;
  showMainAndOpenSettings: () => void;
  emitSurfaceClosed?: (kind: LyricsSurfaceKind) => void;
  emitSurfaceInteraction?: (
    kind: LyricsSurfaceKind,
    interaction: 'interactive' | 'passive-locked',
  ) => void;
  dialogs?: PathPickerDialogs;
  downloadsDir?: () => string;
  folders?: HostFolderOpener;
  oauth?: OAuthHostDeps;
  coreInvoke?: CoreInvoke;
  collectHostPayload?: () => DiagnosticsHostPayload;
  /** Live tray / Ozone facts; overlay Core `platform_diagnostics` (stdio, not IpcRouter). */
  platformFacts?: () => HostPlatformFacts;
  /** Host-owned FACT shortcuts. Throws on unsupported enable or total registration failure. */
  setShortcutsEnabled?: (enabled: boolean) => unknown;
  deepLinkStatus?: () => DeepLinkRegistrationStatus;
  takePendingDeepLink?: () => OpenCatalogSongPayload | null;
  /** Core data dir; used to hydrate managed background `dataUri` after stdio. */
  dataDir?: () => string;
  updater?: HostUpdaterDeps;
  windowChrome?: HostWindowChromeLookup;
  coreStatus?: () => CoreStatusPayload;
};

export function createHostHandlers(deps: HostHandlerDeps): Record<string, HostHandler> {
  const hostInteraction: Record<LyricsSurfaceKind, SurfaceInteractionName> = {
    desktop: 'interactive',
    island: 'interactive',
  };
  // Tray/settings unlock persists directly through the host while the Main
  // renderer may still reconcile its older passive preference. Remember that
  // narrow hand-off so a stale reconcile cannot immediately relock the surface.
  const pendingUnlock = new Set<LyricsSurfaceKind>();
  const authorizedStatisticsExports = new Map<string, number>();
  const exportPathKey = (target: string): string => {
    const resolved = path.resolve(target);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const statisticsAuthorizationKey = (
    webContentsId: number,
    target: string,
    format: 'json' | 'csv',
  ): string => `${webContentsId}\0${format}\0${exportPathKey(target)}`;

  const hideLegacyUnlockOverlay = (kind: LyricsSurfaceKind): void => {
    deps.unlock.hide(kind);
  };

  const applyNativeInteraction = (kind: LyricsSurfaceKind): void => {
    const locked = hostInteraction[kind] === 'passive-locked';
    deps.lyrics.lock(kind, locked);
    // A locked surface is fully click-through. Recovery lives in the tray (and
    // Settings), so no always-on-top unlock target can be clicked accidentally.
    hideLegacyUnlockOverlay(kind);
    deps.emitSurfaceInteraction?.(kind, hostInteraction[kind]);
  };

  const stampHostInteraction = (raw: string): string => {
    let next = raw;
    for (const kind of ['desktop', 'island'] as const) {
      const patched = patchSurfaceInteractionDocument(next, kind, hostInteraction[kind]);
      if (patched) {
        next = patched;
      }
    }
    return next;
  };

  const persistInteraction = async (
    kind: LyricsSurfaceKind,
    interaction: SurfaceInteractionName,
    fallbackValue: unknown,
  ): Promise<string> => {
    const fallback =
      typeof fallbackValue === 'string' && fallbackValue.length > 0 ? fallbackValue : '';
    let source = fallback;
    if (!source && deps.coreInvoke) {
      const raw = await deps.coreInvoke('app_preferences_get', undefined, 'host');
      source = typeof raw === 'string' ? raw : '';
    }
    const next = source ? patchSurfaceInteractionDocument(source, kind, interaction) : undefined;
    if (!next) {
      return fallback;
    }
    if (!deps.coreInvoke) {
      return next;
    }
    // Generic preference writes intentionally preserve the old interaction in
    // Core. Only this host-only command may change it and returns the stored doc.
    const stored = await deps.coreInvoke(
      'app_preferences_set_surface_interaction',
      { kind, interaction, value: next },
      'host',
    );
    if (typeof stored !== 'string' || !stored.length) {
      throw new Error('Core did not return persisted lyrics interaction');
    }
    return stored;
  };

  const applyKind = async (
    kind: LyricsSurfaceKind,
    config: SurfaceRuntimeLike | undefined,
  ): Promise<void> => {
    if (!config || config.enabled !== true) {
      deps.lyrics.hide(kind);
      deps.unlock.hide(kind);
      return;
    }
    const requested = asSurfaceInteraction(config.interaction);
    if (requested === 'passive-locked') {
      if (!pendingUnlock.has(kind)) {
        if (hostInteraction[kind] !== 'passive-locked') {
          // Repair older installs whose local cache was locked but Core never saved it.
          await persistInteraction(kind, 'passive-locked', undefined);
        }
        hostInteraction[kind] = 'passive-locked';
      }
    } else if (requested === 'interactive' && pendingUnlock.delete(kind)) {
      hostInteraction[kind] = 'interactive';
    }
    deps.lyrics.show(kind);
    applyNativeInteraction(kind);
  };

  const handlers: Record<string, HostHandler> = {
    [SHELL_OPEN_EXTERNAL]: async (params) => {
      const url = urlFromOpenExternalParams(params);
      return openExternalIfAllowed(deps.openExternal, url, deps.extraHttpsUrls?.() ?? []);
    },
    [CLIPBOARD_WRITE_TEXT]: async (params) => {
      if (!deps.writeClipboardText) {
        throw new Error('Native clipboard is unavailable');
      }
      await deps.writeClipboardText(textFromClipboardParams(params));
    },
    lyrics_surfaces_reconcile: async (params) => {
      const surfaces = asSurfaceRuntimeMap(params);
      await applyKind('desktop', surfaces?.desktop);
      await applyKind('island', surfaces?.island);
      return deps.capabilities();
    },
    lyrics_surface_capabilities: async () => deps.capabilities(),
    lyrics_surface_status: async () => ({
      desktop: deps.lyrics.get('desktop') !== undefined,
      island: deps.lyrics.get('island') !== undefined,
    }),
    lyrics_surface_close: async (params, _webContentsId, origin) => {
      const kind = lyricsKindFromParams(params);
      if (!kind || !originMayControlKind(origin, kind)) {
        return;
      }
      deps.lyrics.hide(kind);
      deps.unlock.hide(kind);
      deps.emitSurfaceClosed?.(kind);
    },
    lyrics_surface_set_interaction: async (params, _webContentsId, origin) => {
      const kind = lyricsKindFromParams(params);
      if (!kind || !originMayControlKind(origin, kind)) {
        return '';
      }
      const interaction = asSurfaceInteraction(
        params && typeof params === 'object'
          ? (params as { interaction?: unknown }).interaction
          : undefined,
      );
      if (!interaction) {
        return '';
      }
      const value =
        params && typeof params === 'object' ? (params as { value?: unknown }).value : undefined;
      const stored = await persistInteraction(kind, interaction, value);
      if (interaction === 'passive-locked') {
        pendingUnlock.delete(kind);
      }
      hostInteraction[kind] = interaction;
      applyNativeInteraction(kind);
      return stored;
    },
    lyrics_surface_show_settings: async () => {
      deps.showMainAndOpenSettings();
    },
    lyrics_surface_unlock: async (params, _webContentsId, origin) => {
      const kind = lyricsKindFromParams(params);
      if (!kind || !originMayUnlockKind(origin, kind)) {
        return;
      }
      await persistInteraction(kind, 'interactive', undefined);
      pendingUnlock.add(kind);
      hostInteraction[kind] = 'interactive';
      applyNativeInteraction(kind);
    },
    lyrics_surfaces_unlock_all: async () => {
      let unlocked = 0;
      for (const kind of ['desktop', 'island'] as const) {
        if (deps.lyrics.get(kind) === undefined) {
          deps.unlock.hide(kind);
          continue;
        }
        await persistInteraction(kind, 'interactive', undefined);
        pendingUnlock.add(kind);
        hostInteraction[kind] = 'interactive';
        applyNativeInteraction(kind);
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

  if (deps.coreInvoke) {
    const invoke = deps.coreInvoke;
    handlers.app_preferences_set = async (params, _webContentsId, origin) => {
      const record =
        params && typeof params === 'object' ? { ...(params as Record<string, unknown>) } : {};
      const raw = typeof record.value === 'string' ? record.value : '';
      if (raw.length > 0) {
        record.value = stampHostInteraction(raw);
      }
      return invoke('app_preferences_set', record, origin ?? 'host');
    };
  }

  if (deps.dialogs) {
    const { showSaveDialog, showOpenDialog } = deps.dialogs;
    handlers.plugin_pick_directory = async () => pickDirectory(showOpenDialog);
    handlers[DIALOG_PICK_FILE] = async (params) => {
      const kind = openFileKindFromParams(params);
      return pickFile(showOpenDialog, { filters: filtersFor(kind) });
    };
    handlers[DIALOG_PICK_SAVE] = async (params, webContentsId) => {
      const downloads = deps.downloadsDir?.() ?? '';
      const kind = saveFileKindFromParams(params);
      const format = kind === 'statistics-json' ? 'json' : kind === 'statistics-csv' ? 'csv' : null;
      const fallback = format ? `YAQMC-statistics.${format}` : DIAGNOSTICS_ZIP_DEFAULT_NAME;
      const initialPath = defaultPathFromParams(params, fallback);
      const chosen = await pickSave(showSaveDialog, {
        filters: filtersFor(kind),
        defaultPath: format
          ? resolveStatisticsSavePath(initialPath, downloads, format)
          : resolveDiagnosticsSavePath(initialPath, downloads),
      });
      if (chosen === null) {
        return null;
      }
      const resolved = format
        ? resolveStatisticsSavePath(chosen, downloads, format)
        : resolveDiagnosticsSavePath(chosen, downloads);
      if (format) {
        if (webContentsId === undefined) {
          throw new Error('statistics save dialog requires a renderer window');
        }
        const now = Date.now();
        for (const [key, expiresAt] of authorizedStatisticsExports) {
          if (expiresAt <= now) authorizedStatisticsExports.delete(key);
        }
        if (authorizedStatisticsExports.size >= 16) authorizedStatisticsExports.clear();
        authorizedStatisticsExports.set(
          statisticsAuthorizationKey(webContentsId, resolved, format),
          now + 5 * 60_000,
        );
      }
      return resolved;
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
      const next = hostPayload ? attachHostPayloadToExportParams(params, hostPayload) : params;
      return deps.coreInvoke!(method, next, origin);
    };
    handlers.diagnostics_export_bundle_to = async (params, _webContentsId, origin) => {
      const record =
        params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
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

  handlers.statistics_export_to = async (params, webContentsId, origin) => {
    const record = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
    const request =
      record.request && typeof record.request === 'object'
        ? (record.request as Record<string, unknown>)
        : {};
    const target = typeof request.path === 'string' ? request.path : '';
    const format = request.format === 'json' || request.format === 'csv' ? request.format : null;
    const key =
      target && format && webContentsId !== undefined
        ? statisticsAuthorizationKey(webContentsId, target, format)
        : '';
    const expiresAt = key ? authorizedStatisticsExports.get(key) : undefined;
    if (!key || expiresAt === undefined || expiresAt <= Date.now()) {
      if (key) authorizedStatisticsExports.delete(key);
      throw new Error('statistics export path was not authorized by the save dialog');
    }
    authorizedStatisticsExports.delete(key);
    if (!deps.coreInvoke) {
      throw new Error('statistics export requires the Core bridge');
    }
    return deps.coreInvoke('statistics_export_to', params, origin);
  };

  if (deps.coreInvoke && deps.dataDir) {
    const dataDir = deps.dataDir;
    const invokeAndHydrate = async (method: string, params: unknown, origin?: string) =>
      hydrateManagedBackground(await deps.coreInvoke!(method, params, origin), dataDir());
    handlers.preferences_set_background_from = async (params, _webContentsId, origin) =>
      invokeAndHydrate('preferences_set_background_from', params, origin);
    handlers.appearance_background_load = async (params, _webContentsId, origin) =>
      invokeAndHydrate('appearance_background_load', params, origin);
  }

  if (deps.coreInvoke && deps.platformFacts) {
    const invoke = deps.coreInvoke;
    const platformFacts = deps.platformFacts;
    handlers.platform_diagnostics = async (_params, _webContentsId, origin) => {
      const core = await invoke('platform_diagnostics', undefined, origin);
      return overlayPlatformDiagnostics(core, platformFacts());
    };
  }

  if (deps.platformFacts) {
    const platformFacts = deps.platformFacts;
    handlers.system_integration_status = async () => desktopIntegrationFromFacts(platformFacts());
    if (deps.setShortcutsEnabled) {
      const setShortcutsEnabled = deps.setShortcutsEnabled;
      handlers[SYSTEM_SHORTCUTS_SET_ENABLED] = async (params) => {
        setShortcutsEnabled(enabledFromParams(params));
        return desktopIntegrationFromFacts(platformFacts());
      };
    }
  }

  if (deps.deepLinkStatus) {
    handlers.deep_link_status = async () => deps.deepLinkStatus!();
  }
  if (deps.takePendingDeepLink) {
    handlers.deep_link_take_pending = async () => deps.takePendingDeepLink!();
  }

  if (deps.updater) {
    const updater = deps.updater;
    handlers[HOST_UPDATER_CHECK_METHOD] = async () => updater.check();
    handlers[HOST_UPDATER_DOWNLOAD_METHOD] = async () => updater.download();
    handlers[HOST_UPDATER_INSTALL_METHOD] = async () => updater.install();
    handlers.host_updater_status = async () => updater.status?.();
    handlers.host_updater_cancel = async () => updater.cancel?.();
    handlers.host_updater_start = async (params) => {
      const value = params as { candidateId?: unknown };
      if (
        !value ||
        typeof value.candidateId !== 'string' ||
        Object.keys(value).some((k) => k !== 'candidateId')
      ) {
        throw new Error('update-candidate-invalid');
      }
      return updater.start?.(value.candidateId);
    };
    handlers.host_updater_preferences = async (params) => {
      const value = params as { includePrerelease?: unknown };
      if (
        !value ||
        typeof value.includePrerelease !== 'boolean' ||
        Object.keys(value).some((k) => k !== 'includePrerelease')
      ) {
        throw new Error('update-preferences-invalid');
      }
      return updater.preferences?.(value.includePrerelease);
    };
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
      const authorization = await openOAuthWindow(loginProvider, {
        createWindow: oauth.createWindow,
        fromPartition: oauth.fromPartition,
        isPackaged: oauth.isPackaged,
        auth_oauth_prepare: (prepareParams) =>
          oauth.invoke('auth_oauth_prepare', prepareParams) as Promise<OAuthPrepareResult>,
        auth_oauth_complete: (completeParams) =>
          oauth.invoke('auth_oauth_complete', completeParams),
        auth_oauth_cancel: (cancelParams) => oauth.invoke('auth_oauth_cancel', cancelParams),
      });
      // Return the owned waiting snapshot now so the renderer can heartbeat it.
      // Waiting for the popup here keeps the renderer busy until its lease expires.
      // Completion (including failure/cancellation) is published through account events.
      void authorization.completion.catch(() => undefined);
      return oauth.invoke('qqmusic_account_snapshot');
    };
    handlers.provider_auth_oauth_start = async (params) => {
      const input = providerOAuthFromParams(params);
      if (!input) {
        throw new Error('provider_auth_oauth_start requires providerId and methodId');
      }
      const scope = {
        providerId: input.providerId,
        ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
      };
      const authorization = await openProviderOAuthWindow(input, {
        createWindow: oauth.createWindow,
        fromPartition: oauth.fromPartition,
        isPackaged: oauth.isPackaged,
        provider_auth_oauth_prepare: (prepareParams) =>
          oauth.invoke('provider_auth_oauth_prepare', {
            ...prepareParams,
            ...scope,
          }) as Promise<OAuthPrepareResult>,
        provider_auth_oauth_complete: (completeParams) =>
          oauth.invoke('provider_auth_oauth_complete', { ...completeParams, ...scope }),
        provider_auth_oauth_cancel: (cancelParams) =>
          oauth.invoke('provider_auth_oauth_cancel', { ...cancelParams, ...scope }),
      });
      void authorization.completion.catch(() => undefined);
      return oauth.invoke('provider_account_snapshot', scope);
    };
  }

  // Settings, tray actions and startup reconciliation share one ordered stream.
  // A slower save must not apply a stale lock after a later unlock has completed.
  let interactionTransition: Promise<unknown> = Promise.resolve();
  for (const method of [
    'lyrics_surfaces_reconcile',
    'lyrics_surface_set_interaction',
    'lyrics_surface_unlock',
    'lyrics_surfaces_unlock_all',
  ]) {
    const handler = handlers[method];
    if (!handler) continue;
    handlers[method] = (...args) => {
      const next = interactionTransition.then(() => handler(...args));
      interactionTransition = next.catch(() => undefined);
      return next;
    };
  }
  return handlers;
}
