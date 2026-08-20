import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  protocol,
  screen,
  session,
  shell,
  Tray,
  webContents,
} from 'electron';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANNEL_APP_OPEN_SETTINGS,
  CHANNEL_HOST_CORE_STATUS,
  CHANNEL_LYRICS_DOCUMENT,
  CHANNEL_LYRICS_PROJECTION,
  CHANNEL_LYRICS_SURFACE_CLOSED,
  CHANNEL_LYRICS_SURFACE_INTERACTION,
  CHANNEL_PLAYER_SNAPSHOT,
  CHANNEL_PREFERENCES_CHANGED,
} from '@yaqmc/client';
import { resyncAfterCoreRestart } from './core/resync';
import { CoreSupervisor, resolveCoreLaunch, type CoreStatusPayload } from './core/supervisor';
import { resolveCorePaths } from './core/paths';
import { EVENT_CHANNEL, INVOKE_CHANNEL, type InvokeRequest } from './ipc';
import { loadMethodAclFromFile } from './ipc/channels';
import {
  createHostHandlers,
  isNativeWaylandSession,
  lyricsRoleFromCreateOptions,
  lyricsSurfaceCapabilities,
  lyricsUnlockRoleFromKind,
  playerInvokeMethod,
  rememberCloseToTray,
  type HostWindowChrome,
} from './ipc/host-handlers';
import { IpcRouter } from './ipc/router';
import {
  buildPlatformAttach,
  raiseMainWindow as raiseHostMainWindow,
  subscribeHostCommands,
} from './host-commands';
import {
  collectDiagnosticsHostPayload,
  diagnosticsDisplayBackend,
  diagnosticsDisplayCapabilities,
  HOST_LOG_TAIL_MAX_BYTES,
} from './diagnostics-host-payload';
import {
  isNativeWaylandDisplayBackend,
  probeLinuxDisplayBackend,
  readLinuxFdTargets,
  shortcutsEnabledFromPreferences,
} from './platform-diagnostics';
import { createHostLog, type HostLog } from './host-log';
import { linuxGraphicsDiagnostics, linuxGraphicsSwitches } from './linux-graphics';
import { createElectronUpdaterPort, noopUpdaterPort } from './services/electron-updater-port';
import { createUpdater, type UpdaterHandle } from './services/updater';
import { APP_SCHEME, appIndexUrl, serveAppUrl } from './protocol';
import { applyAppWindowGuards, applySessionSecurity, VITE_DEV_ORIGIN } from './security';
import { createGlobalShortcutSession } from './services/shortcuts';
import {
  createTray,
  shouldHideInsteadOfClose,
  type TrayHandle,
  type TrayMenuId,
} from './services/tray';
import { localeFromPreferences, trayLabelsForLocale } from './services/tray-i18n';
import { acquireSingleInstanceLock } from './single-instance';
import { subscribeSurfaceAutoHide } from './windows/surface-auto-hide';
import {
  createLyricsSurfaces,
  lyricsSurfaceSettingsFromCore,
  lyricsSurfaceUrl,
  type LyricsSurfaceCreateOptions,
  type LyricsSurfaceKind,
  type LyricsSurfacePersistedGeometry,
} from './windows/lyrics-surfaces';
import {
  createLyricsUnlockOverlays,
  lyricsUnlockUrl,
  type LyricsUnlockCreateOptions,
  type LyricsUnlockKind,
} from './windows/lyrics-unlock';

type E2ePlayerSnapshotView = {
  queueLength: number;
  currentIndex: number | null;
  currentId: string | null;
  isPlaying: boolean;
  playbackState: string;
  snapshotRevision: number;
  errorCode: string | null;
};

function e2eViewFromPlayerPayload(payload: unknown): E2ePlayerSnapshotView | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const rec = payload as Record<string, unknown>;
  const queue = rec.queue;
  const err = rec.playbackError;
  return {
    queueLength: Array.isArray(queue) ? queue.length : 0,
    currentIndex: typeof rec.currentIndex === 'number' ? rec.currentIndex : null,
    currentId: typeof rec.currentQueueEntryId === 'string' ? rec.currentQueueEntryId : null,
    isPlaying: rec.isPlaying === true,
    playbackState: typeof rec.playbackState === 'string' ? rec.playbackState : '',
    snapshotRevision: typeof rec.snapshotRevision === 'number' ? rec.snapshotRevision : 0,
    errorCode:
      err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : null,
  };
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const linuxRendererEnv = process.env.YAQMC_LINUX_RENDERER;
const linuxGraphicsFacts = {
  platform: process.platform,
  wayland: Boolean(process.env.WAYLAND_DISPLAY),
  nvidia: false,
  mode: linuxRendererEnv ?? 'auto',
  fromDeprecatedEnv: Boolean(linuxRendererEnv),
};

function applyLinuxGraphicsSwitches(): void {
  const flags = linuxGraphicsSwitches(linuxGraphicsFacts);
  for (const flag of flags) {
    const body = flag.startsWith('--') ? flag.slice(2) : flag;
    const separator = body.indexOf('=');
    if (separator === -1) {
      app.commandLine.appendSwitch(body);
    } else {
      app.commandLine.appendSwitch(body.slice(0, separator), body.slice(separator + 1));
    }
  }
}

applyLinuxGraphicsSwitches();

const here = path.dirname(fileURLToPath(import.meta.url));
const smoke = process.env.YAQMC_DESKTOP_SMOKE === '1';
/** Local Playwright `_electron` (FE-06 follow-up). Not the smoke harness; not CI. */
const e2e = process.env.YAQMC_ELECTRON_E2E === '1';
const e2eNative = e2e && process.env.YAQMC_E2E_NATIVE === '1';
if (e2e) {
  app.setPath('userData', path.join(os.tmpdir(), 'yaqmc-electron-e2e', 'userData'));
}
const desktopRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(desktopRoot, '../..');
const harnessRoot = path.join(desktopRoot, 'harness');
const viteDist = path.join(repoRoot, 'dist');
const preloadPath = path.join(here, '../preload/main.cjs');
const lyricsPreloadPath = path.join(here, '../preload/lyrics-surface.cjs');
const unlockPreloadPath = path.join(here, '../preload/unlock-overlay.cjs');
const resourcesDir = path.join(desktopRoot, 'resources');
const nativeWayland = isNativeWaylandSession();

function liveDisplayBackend(): string {
  if (process.platform !== 'linux') {
    return process.platform;
  }
  return probeLinuxDisplayBackend({
    ozonePlatform:
      app.commandLine.getSwitchValue('ozone-platform') ||
      (linuxGraphicsFacts.mode.trim().toLowerCase() === 'native-wayland' ? 'wayland' : null),
    fdTargets: readLinuxFdTargets(),
    waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
    x11Display: process.env.DISPLAY ?? null,
  });
}

let supervisor: CoreSupervisor | undefined;
let stopping = false;
let exitCode = 0;
let mainWindow: BrowserWindow | undefined;
let e2eSecondInstanceHits = 0;
let e2eOpenSettingsHits = 0;
let e2ePlayerSnapshotHits = 0;
let e2eLastPlayerSnapshot: E2ePlayerSnapshotView | null = null;
let trayHandle: TrayHandle | undefined;
let trayError: string | null = null;
/** Last `app_preferences_get` / `preferences://changed` document. Tray is created after Core ready. */
let lastPreferencesRaw: unknown;
/** FACT default: hide-to-tray. Preference read is cached; missing prefs stay hide. */
let closeToTray = true;
let hostLog: HostLog | undefined;

function writeHostLog(message: string): void {
  try {
    hostLog?.append(message);
  } catch {
    // Host logging must not take down the process.
  }
}

function rendererDevPageUrl(search: string): string | null {
  if (app.isPackaged || process.env.YAQMC_VITE_DEV !== '1') {
    return null;
  }
  return `${VITE_DEV_ORIGIN}/${search}`;
}

const lyricsUnlock = createLyricsUnlockOverlays({
  preloadPath: unlockPreloadPath,
  createWindow: createUnlockBrowserWindow,
  pageUrl: (kind) =>
    rendererDevPageUrl(`?unlockSurface=${kind}`) ?? lyricsUnlockUrl(kind),
});

const lyricsSurfaces = createLyricsSurfaces({
  preloadPath: lyricsPreloadPath,
  createWindow: createLyricsBrowserWindow,
  pageUrl: (kind) =>
    rendererDevPageUrl(`?surface=${kind}`) ?? lyricsSurfaceUrl(kind),
  getDisplayBounds: () =>
    screen.getAllDisplays().map((display) => ({
      x: display.workArea.x,
      y: display.workArea.y,
      width: display.workArea.width,
      height: display.workArea.height,
    })),
  // BASE-04 keys: app_settings['lyrics-surface-geometry:desktop'] and
  // app_settings['lyrics-surface-geometry:island'] via CoreClient.
  settings: lyricsSurfaceSettingsFromCore(() => supervisor?.client),
  onBoundsChanged: (kind, geometry) => {
    lyricsUnlock.position(kind, geometry);
  },
});

const shortcutSession = createGlobalShortcutSession({
  globalShortcut,
  invokePlayer,
  platform: () => process.platform,
  wayland: () => isNativeWaylandDisplayBackend(liveDisplayBackend()),
  log: {
    warn(message, extra) {
      console.warn(message, extra);
    },
  },
});

if (e2e) {
  (
    globalThis as {
      __YAQMC_E2E__?: {
        coreStatus: () => string;
        corePid: () => number | null;
        coreDataDir: () => string;
        hostPid: () => number;
        killCore: () => boolean;
        trayClick: (id: string) => boolean;
        trayActive: () => boolean;
        mainVisible: () => boolean;
        mainHide: () => boolean;
        secondInstanceHits: () => number;
        openSettingsHits: () => number;
        lastPlayerSnapshot: () => E2ePlayerSnapshotView | null;
        playerSnapshotHits: () => number;
        coreInvoke: (method: string, params?: unknown) => Promise<unknown>;
        lyricsShow: (kind: LyricsSurfaceKind) => void;
        lyricsHide: (kind: LyricsSurfaceKind) => void;
        lyricsBounds: (kind: LyricsSurfaceKind) => LyricsSurfacePersistedGeometry | null;
        lyricsSetBounds: (
          kind: LyricsSurfaceKind,
          bounds: LyricsSurfacePersistedGeometry,
        ) => boolean;
        lyricsFlushGeometry: (kind: LyricsSurfaceKind) => Promise<void>;
        lyricsIsLocked: (kind: LyricsSurfaceKind) => boolean;
        lyricsIsVisible: (kind: LyricsSurfaceKind) => boolean;
      };
    }
  ).__YAQMC_E2E__ = {
    coreStatus: () => supervisor?.status ?? 'absent',
    corePid: () => supervisor?.runningChildPid() ?? null,
    coreDataDir: () => coreDataPaths().dataDir,
    hostPid: () => process.pid,
    killCore: () => supervisor?.killRunningChild() ?? false,
    trayClick: (id) => trayHandle?.click(id as TrayMenuId) ?? false,
    trayActive: () => trayHandle !== undefined,
    mainVisible: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    mainHide: () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return false;
      }
      mainWindow.hide();
      return true;
    },
    secondInstanceHits: () => e2eSecondInstanceHits,
    openSettingsHits: () => e2eOpenSettingsHits,
    lastPlayerSnapshot: () => e2eLastPlayerSnapshot,
    playerSnapshotHits: () => e2ePlayerSnapshotHits,
    coreInvoke: (method, params) => {
      const client = supervisor?.client;
      if (!client) {
        return Promise.reject(new Error('core supervisor is not running'));
      }
      return params === undefined ? client.invoke(method) : client.invoke(method, params);
    },
    lyricsShow: (kind) => {
      lyricsSurfaces.show(kind);
    },
    lyricsHide: (kind) => {
      lyricsSurfaces.hide(kind);
    },
    lyricsBounds: (kind) => {
      const bounds = lyricsSurfaces.get(kind)?.getBounds?.();
      if (!bounds) {
        return null;
      }
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    },
    lyricsSetBounds: (kind, bounds) => {
      const window = lyricsSurfaces.get(kind);
      if (!window?.setBounds) {
        return false;
      }
      window.setBounds(bounds);
      return true;
    },
    lyricsFlushGeometry: (kind) => lyricsSurfaces.flushGeometry(kind),
    lyricsIsLocked: (kind) => lyricsSurfaces.isLocked(kind),
    lyricsIsVisible: (kind) => lyricsSurfaces.isVisible(kind),
  };
}

const router = new IpcRouter({
  methods: loadMethodAclFromFile(
    path.join(repoRoot, 'packages/yaqmc-client/fixtures/methods.json'),
  ),
  onDenied: ({ method, role }) => {
    writeHostLog(`acl denied method=${method} role=${role}`);
  },
  hostHandlers: createHostHandlers({
    openExternal: (url) => shell.openExternal(url),
    lyrics: lyricsSurfaces,
    unlock: lyricsUnlock,
    capabilities: () =>
      lyricsSurfaceCapabilities({
        platform: process.platform,
        displayBackend: liveDisplayBackend(),
      }),
    showMainAndOpenSettings: emitOpenSettings,
    emitSurfaceClosed: (kind: LyricsSurfaceKind) => {
      fanoutEvent(CHANNEL_LYRICS_SURFACE_CLOSED, kind);
    },
    emitSurfaceInteraction: (kind: LyricsSurfaceKind, interaction) => {
      fanoutEvent(CHANNEL_LYRICS_SURFACE_INTERACTION, { kind, interaction });
    },
    dialogs: {
      showSaveDialog: (options) =>
        mainWindow && !mainWindow.isDestroyed()
          ? dialog.showSaveDialog(mainWindow, options)
          : dialog.showSaveDialog(options),
      showOpenDialog: (options) =>
        mainWindow && !mainWindow.isDestroyed()
          ? dialog.showOpenDialog(mainWindow, options)
          : dialog.showOpenDialog(options),
    },
    downloadsDir: () => app.getPath('downloads'),
    dataDir: () => coreDataPaths().dataDir,
    // diagnostics_open_log_folder / diagnostics_reveal_bundle: host-owned OS folder APIs.
    folders: {
      logDir: () => coreDataPaths().logDir,
      openPath: (target) => shell.openPath(target),
      showItemInFolder: (target) => {
        shell.showItemInFolder(target);
      },
      exists: (target) => existsSync(target),
    },
    oauth: {
      createWindow: (options) =>
        createOAuthBrowserWindow(options as ConstructorParameters<typeof BrowserWindow>[0]),
      fromPartition: (partition, options) => {
        if (smoke) {
          return {};
        }
        const oauthSession = session.fromPartition(partition, options);
        applySessionSecurity(oauthSession);
        return oauthSession;
      },
      isPackaged: app.isPackaged,
      invoke: invokeOAuthCore,
    },
    coreInvoke: invokeOAuthCore,
    collectHostPayload: collectLiveHostPayload,
    platformFacts: () => {
      const displayBackend = liveDisplayBackend();
      const shortcuts = shortcutSession.status();
      return {
        displayBackend,
        graphicsMode: linuxGraphicsFacts.mode,
        trayAvailable: trayHandle !== undefined,
        trayError,
        globalShortcutsSupported: !isNativeWaylandDisplayBackend(displayBackend),
        globalShortcutsEnabled: shortcuts.globalShortcutsEnabled,
        shortcutError: shortcuts.shortcutError,
      };
    },
    setShortcutsEnabled: (enabled) => shortcutSession.setEnabled(enabled),
    updater: {
      check: () => requireUpdater().check(),
      download: () => requireUpdater().download(),
      install: () => requireUpdater().install(),
    },
    windowChrome: hostWindowChrome,
    // host.coreStatus: renderer markReady probe if it missed host://core-status.
    coreStatus: () => ({ status: supervisor?.status ?? 'down' }),
  }),
});

const updaterHandle = createUpdater({
  port: smoke ? noopUpdaterPort() : createElectronUpdaterPort(updaterReleaseChannel()),
  emit: (channel, payload) => {
    writeHostLog(`updater ${payload.state}`);
    fanoutEvent(channel, payload);
  },
  channel: updaterReleaseChannel(),
  platform: process.platform,
  scheduleCheck: (callback, delayMs) => setTimeout(callback, delayMs),
});

function packagedRendererRoot(): string | undefined {
  if (!app.isPackaged) {
    return undefined;
  }
  const candidate = path.join(process.resourcesPath, 'renderer');
  if (existsSync(path.join(candidate, 'index.html'))) {
    return candidate;
  }
  return undefined;
}

function rendererRoot(): string {
  if (smoke) {
    return harnessRoot;
  }
  const packaged = packagedRendererRoot();
  if (packaged) {
    return packaged;
  }
  if (existsSync(path.join(viteDist, 'index.html'))) {
    return viteDist;
  }
  return harnessRoot;
}

function mainWindowUrl(root: string): string {
  if (!app.isPackaged && process.env.YAQMC_VITE_DEV === '1') {
    return e2e && !e2eNative ? `${VITE_DEV_ORIGIN}/?provider=fake` : `${VITE_DEV_ORIGIN}/`;
  }
  if (!app.isPackaged && root === viteDist) {
    return appIndexUrl('?provider=fake');
  }
  return appIndexUrl();
}

function requireUpdater(): UpdaterHandle {
  if (!updaterHandle) {
    throw new Error('updater is not wired');
  }
  return updaterHandle;
}

function updaterReleaseChannel(): string {
  return __YAQMC_RELEASE_CHANNEL__ === 'nightly' ? 'nightly' : 'latest';
}

function hostWindowChrome(webContentsId: number): HostWindowChrome | undefined {
  const contents = webContents.fromId(webContentsId);
  const window = contents ? BrowserWindow.fromWebContents(contents) : null;
  if (!window || window.isDestroyed()) {
    return undefined;
  }
  return {
    minimize: () => {
      window.minimize();
    },
    toggleMaximize: () => {
      if (window.isMaximized()) {
        window.unmaximize();
      } else {
        window.maximize();
      }
    },
    close: () => {
      window.close();
    },
    setFullscreen: (enabled) => {
      window.setFullScreen(enabled);
    },
  };
}

function collectLiveHostPayload(): ReturnType<typeof collectDiagnosticsHostPayload> {
  const capabilities = diagnosticsDisplayCapabilities(nativeWayland);
  const windows = router.listWindows().map(({ webContentsId, role }) => {
    const contents = webContents.fromId(webContentsId);
    const window = contents ? BrowserWindow.fromWebContents(contents) : null;
    if (!window || window.isDestroyed()) {
      return { id: webContentsId, role, visible: false };
    }
    return {
      id: webContentsId,
      role,
      visible: window.isVisible(),
      focused: window.isFocused(),
      alwaysOnTop: window.isAlwaysOnTop(),
      bounds: window.getBounds(),
    };
  });
  const versions = process.versions as { electron?: string; chrome?: string; node?: string };
  const fileTail = hostLog?.tail(HOST_LOG_TAIL_MAX_BYTES);
  const stderr = supervisor?.stderrSnapshot().toString('utf8');
  const parts = [fileTail, stderr].filter((part): part is string =>
    Boolean(part && part.length > 0),
  );
  const log = parts.join('\n--- core stderr ---\n');
  return collectDiagnosticsHostPayload({
    versions: {
      electron: versions.electron,
      chrome: versions.chrome,
      node: versions.node,
    },
    windows,
    display: {
      backend: diagnosticsDisplayBackend({
        platform: process.platform,
        nativeWayland,
      }),
      capabilities,
    },
    updater: updaterHandle?.payload() ?? {
      state: 'idle',
      canInstall: false,
      channel: updaterReleaseChannel(),
    },
    restartCounter: supervisor?.restartCount() ?? 0,
    log,
    linuxGraphics: linuxGraphicsDiagnostics(linuxGraphicsFacts),
  });
}

function quitWith(code: number): void {
  exitCode = code;
  stopping = true;
  if (!supervisor) {
    app.exit(code);
    return;
  }
  app.quit();
}

function invokePlayer(method: 'toggle' | 'next' | 'previous'): Promise<void> | undefined {
  const client = supervisor?.client;
  if (!client) {
    return undefined;
  }
  return client.invoke(playerInvokeMethod(method)).then(() => undefined);
}

function invokeOAuthCore(method: string, params?: unknown, origin?: string): Promise<unknown> {
  const client = supervisor?.client;
  if (!client) {
    return Promise.reject(new Error('core supervisor is not running'));
  }
  return client.invoke(method, params, origin);
}

function createOAuthBrowserWindow(options: ConstructorParameters<typeof BrowserWindow>[0]) {
  if (smoke) {
    throw new Error('oauth BrowserWindow is disabled during YAQMC_DESKTOP_SMOKE');
  }
  return new BrowserWindow(options);
}

function quitFromHostCommand(): void {
  if (stopping) {
    return;
  }
  stopping = true;
  app.quit();
}

function emitOpenSettings(): void {
  if (e2e) {
    e2eOpenSettingsHits += 1;
  }
  raiseHostMainWindow(mainWindow);
  fanoutEvent(CHANNEL_APP_OPEN_SETTINGS, null);
}

function sendPlatformAttach(): void {
  const client = supervisor?.client;
  const window = mainWindow;
  if (!client || !window || window.isDestroyed()) {
    return;
  }
  const attach = buildPlatformAttach({
    platform: process.platform,
    smoke,
    nativeWayland,
    getNativeWindowHandle: () => window.getNativeWindowHandle(),
  });
  void client.invoke('platform_attach', attach).catch(() => {
    // Core may stub {ok:true}; SMTC/MPRIS stay unverified.
  });
}

function pushCoreStatus(contentsId: number): void {
  const contents = webContents.fromId(contentsId);
  if (!contents || contents.isDestroyed()) {
    return;
  }
  contents.send(EVENT_CHANNEL, {
    channel: CHANNEL_HOST_CORE_STATUS,
    payload: { status: supervisor?.status ?? 'down' },
  });
}

function pushSurfaceInteraction(role: ReturnType<typeof lyricsRoleFromCreateOptions>): void {
  const kind = role === 'lyrics-island' ? 'island' : role === 'lyrics-desktop' ? 'desktop' : undefined;
  if (!kind) {
    return;
  }
  fanoutEvent(CHANNEL_LYRICS_SURFACE_INTERACTION, {
    kind,
    interaction: lyricsSurfaces.isLocked(kind) ? 'passive-locked' : 'interactive',
  });
}

function bindOverlayVisibilityThrottle(window: BrowserWindow): void {
  let visualGeneration = 0;
  const apply = () => {
    if (window.isDestroyed()) return;
    const visible = window.isVisible();
    window.webContents.setBackgroundThrottling(!visible);
    const generation = (visualGeneration += 1);
    const visual = visible ? 'active' : 'idle';
    void window.webContents
      .executeJavaScript(
        `(function () {
          if ((window.__yaqmcSurfaceVisualGen ?? 0) > ${String(generation)}) return;
          window.__yaqmcSurfaceVisualGen = ${String(generation)};
          var next = ${JSON.stringify(visual)};
          if (document.documentElement.dataset.surfaceVisual === next) return;
          document.documentElement.dataset.surfaceVisual = next;
          window.dispatchEvent(new Event('yaqmc-surface-visual'));
        })()`,
      )
      .catch(() => undefined);
  };
  apply();
  window.webContents.on('did-finish-load', apply);
  window.on('show', apply);
  window.on('hide', apply);
  window.on('minimize', apply);
  window.on('restore', apply);
}

function createLyricsBrowserWindow(options: LyricsSurfaceCreateOptions) {
  const { alwaysOnTop, ...rest } = options;
  void alwaysOnTop;
  const window = new BrowserWindow({
    ...rest,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
  });
  const contentsId = window.webContents.id;
  const role = lyricsRoleFromCreateOptions(options);
  router.registerWindow(contentsId, role);
  writeHostLog(`window lyrics created role=${role}`);
  applyAppWindowGuards(window, {
    allowViteDevServer: !app.isPackaged && process.env.YAQMC_VITE_DEV === '1',
  });
  bindOverlayVisibilityThrottle(window);
  window.webContents.on('did-finish-load', () => {
    pushCoreStatus(contentsId);
    pushSurfaceInteraction(role);
    setTimeout(() => {
      pushCoreStatus(contentsId);
      pushSurfaceInteraction(role);
    }, 0);
  });
  window.on('closed', () => {
    writeHostLog('window lyrics closed');
    router.unregisterWindow(contentsId);
  });
  return window;
}

function createUnlockBrowserWindow(options: LyricsUnlockCreateOptions, kind: LyricsUnlockKind) {
  const { alwaysOnTop, ...rest } = options;
  void alwaysOnTop;
  const window = new BrowserWindow({
    ...rest,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
  });
  const contentsId = window.webContents.id;
  router.registerWindow(contentsId, lyricsUnlockRoleFromKind(kind));
  writeHostLog(`window unlock created kind=${kind}`);
  applyAppWindowGuards(window, {
    allowViteDevServer: !app.isPackaged && process.env.YAQMC_VITE_DEV === '1',
  });
  window.setAlwaysOnTop(true, 'screen-saver');
  bindOverlayVisibilityThrottle(window);
  window.webContents.on('did-finish-load', () => {
    pushCoreStatus(contentsId);
    setTimeout(() => pushCoreStatus(contentsId), 0);
  });
  window.on('closed', () => {
    writeHostLog(`window unlock closed kind=${kind}`);
    router.unregisterWindow(contentsId);
  });
  return window;
}

function createMainWindow(root: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 680,
    show: !smoke,
    frame: false,
    icon: path.join(
      desktopRoot,
      'resources',
      process.platform === 'win32' ? 'icon.ico' : 'icon.png',
    ),
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
  });
  const contentsId = window.webContents.id;
  router.registerWindow(contentsId, 'main');
  mainWindow = window;
  writeHostLog('window main created');
  window.on('close', (event) => {
    if (smoke || stopping) {
      return;
    }
    if (shouldHideInsteadOfClose({ closeToTray, trayActive: trayHandle !== undefined })) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => {
    writeHostLog('window main closed');
    router.unregisterWindow(contentsId);
    if (mainWindow === window) {
      mainWindow = undefined;
    }
    if (!stopping) {
      app.quit();
    }
  });
  applyAppWindowGuards(window, {
    allowViteDevServer: !app.isPackaged && process.env.YAQMC_VITE_DEV === '1',
  });
  void window.loadURL(mainWindowUrl(root));
  return window;
}

function fanoutEvent(channel: string, payload: unknown): void {
  if (e2e && channel === CHANNEL_PLAYER_SNAPSHOT) {
    const view = e2eViewFromPlayerPayload(payload);
    if (view) {
      e2eLastPlayerSnapshot = view;
      e2ePlayerSnapshotHits += 1;
    }
  }
  if (channel === CHANNEL_PREFERENCES_CHANGED) {
    closeToTray = rememberCloseToTray(payload, closeToTray);
    applyTrayLabelsFromPreferences(payload);
    applyShortcutsFromPreferences(payload);
  }
  router.fanout(channel, payload, (id, eventFrame) => {
    webContents.fromId(id)?.send(EVENT_CHANNEL, eventFrame);
  });
}

function bindCoreEvents(): void {
  supervisor?.client.on('event', (frame: { channel: string; payload: unknown }) => {
    fanoutEvent(frame.channel, frame.payload);
  });
}

function cacheCloseToTrayPreference(): void {
  const client = supervisor?.client;
  if (!client) {
    return;
  }
  void client
    .invoke('app_preferences_get')
    .then((raw) => {
      closeToTray = rememberCloseToTray(raw, closeToTray);
      applyTrayLabelsFromPreferences(raw);
      applyShortcutsFromPreferences(raw);
    })
    .catch(() => {
      // FACT: preference read deferred / failed → keep default hide-to-tray.
    });
}

function attachSupervisor(instance: CoreSupervisor): void {
  instance.on('status', (payload: CoreStatusPayload) => {
    writeHostLog(`core-status ${payload.status}`);
    fanoutEvent(CHANNEL_HOST_CORE_STATUS, payload);
  });
  instance.on('ready', (info: { restart: boolean }) => {
    writeHostLog(`core ready restart=${info.restart}`);
    router.setClient(instance.client);
    bindCoreEvents();
    cacheCloseToTrayPreference();
    void lyricsSurfaces.restoreGeometry();
    subscribeSurfaceAutoHide(instance.client, lyricsSurfaces);
    subscribeHostCommands(instance.client, {
      raiseMainWindow: () => raiseHostMainWindow(mainWindow),
      quit: quitFromHostCommand,
    });
    sendPlatformAttach();
    if (!info.restart) {
      return;
    }
    void resyncAfterCoreRestart(instance.client).then((pulled) => {
      fanoutEvent(CHANNEL_PLAYER_SNAPSHOT, pulled.snapshot);
      fanoutEvent(CHANNEL_LYRICS_PROJECTION, pulled.projection);
      if (pulled.document) {
        fanoutEvent(CHANNEL_LYRICS_DOCUMENT, pulled.document);
      }
    });
  });
}

function coreDataPaths() {
  if (smoke || e2e) {
    const tempRoot = path.join(app.getPath('temp'), e2e ? 'yaqmc-electron-e2e' : 'yaqmc-core');
    return {
      dataDir: path.join(tempRoot, 'data'),
      cacheDir: path.join(tempRoot, 'cache'),
      logDir: path.join(tempRoot, 'logs'),
      configDir: path.join(tempRoot, 'config'),
    };
  }
  return resolveCorePaths();
}

function startSupervisor(): Promise<void> {
  const paths = coreDataPaths();
  // Rotating host.log lives in the Core log dir (DIAG leftover, §27.1).
  hostLog = createHostLog({ logDir: paths.logDir });
  if (e2e && process.env.YAQMC_E2E_CORE !== '1') {
    writeHostLog('supervisor skip: YAQMC_ELECTRON_E2E (set YAQMC_E2E_CORE=1 to spawn)');
    return Promise.resolve();
  }
  const launch = resolveCoreLaunch({
    env: process.env,
    stagedDir: path.join(desktopRoot, 'resources', 'core'),
    resourcesPath: process.resourcesPath,
    cargoTargetDir: process.env.CARGO_TARGET_DIR,
    repoRoot,
    packaged: app.isPackaged,
  });
  if (!launch) {
    writeHostLog('supervisor skip: yaqmc-core binary not found');
    if (smoke) {
      throw new Error(
        'yaqmc-core binary was not found (set YAQMC_CORE_BIN or stage resources/core)',
      );
    }
    return Promise.resolve();
  }
  writeHostLog(`supervisor start binary=${launch.binary}`);
  supervisor = new CoreSupervisor({
    binary: launch.binary,
    integrity: launch.integrity,
    ...paths,
    hostVersion: app.getVersion(),
    expectedCoreVersion: app.getVersion(),
  });
  attachSupervisor(supervisor);
  return supervisor.start().then(() => undefined);
}

function applyTrayLabelsFromPreferences(raw: unknown): void {
  if (raw !== undefined) {
    lastPreferencesRaw = raw;
  }
  trayHandle?.applyLabels(
    trayLabelsForLocale(
      localeFromPreferences(lastPreferencesRaw) ?? 'system',
      app.getLocale(),
    ),
  );
}

function applyShortcutsFromPreferences(raw: unknown): void {
  if (smoke) {
    return;
  }
  shortcutSession.applyPreference(shortcutsEnabledFromPreferences(raw));
}

function installTrayAndShortcuts(): void {
  if (smoke || (e2e && process.env.YAQMC_E2E_TRAY !== '1')) {
    return;
  }
  try {
    trayHandle = createTray({
      apis: { Tray, Menu },
      resourcesDir,
      getMainWindow: () => mainWindow,
      invokePlayer,
      openSettings: emitOpenSettings,
      quit: () => {
        stopping = true;
        app.quit();
      },
      labels: trayLabelsForLocale(
        localeFromPreferences(lastPreferencesRaw) ?? 'system',
        app.getLocale(),
      ),
    });
    trayError = null;
    applyTrayLabelsFromPreferences(lastPreferencesRaw);
  } catch (error) {
    console.warn('tray unavailable', error);
    trayHandle = undefined;
    trayError = error instanceof Error ? error.message : String(error);
  }
}

function teardownHostChrome(): void {
  shortcutSession.dispose();
  trayHandle?.destroy();
  trayHandle = undefined;
}

ipcMain.handle(INVOKE_CHANNEL, async (event, request: InvokeRequest) => {
  return router.invoke(event.sender.id, request);
});

if (
  acquireSingleInstanceLock(app, () => {
    if (e2e) {
      e2eSecondInstanceHits += 1;
    }
    return mainWindow;
  })
) {
  app.whenReady().then(async () => {
    applySessionSecurity(session.defaultSession);
    const root = rendererRoot();
    protocol.handle(APP_SCHEME, async (request) => {
      const served = await serveAppUrl(root, request.url);
      return new Response(served.body, {
        status: served.status,
        headers: served.headers,
      });
    });
    try {
      await startSupervisor();
    } catch (error) {
      console.error(error);
      quitWith(1);
      return;
    }
    createMainWindow(root);
    sendPlatformAttach();
    installTrayAndShortcuts();
    if (!smoke && app.isPackaged) {
      updaterHandle?.scheduleLaunchCheck();
    }
    if (smoke && mainWindow) {
      mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
        console.error(`harness failed to load: ${code} ${description}`);
        quitWith(1);
      });
      mainWindow.webContents.on('render-process-gone', (_event, details) => {
        console.error(`harness renderer gone: ${details.reason}`);
        quitWith(1);
      });
      mainWindow.webContents.on('page-title-updated', (_event, title) => {
        if (title === 'yaqmc-smoke-ok') {
          quitWith(0);
        } else if (title === 'yaqmc-smoke-fail') {
          quitWith(1);
        }
      });
    }
  });

  app.on('before-quit', (event) => {
    stopping = true;
    teardownHostChrome();
    if (!supervisor) {
      return;
    }
    event.preventDefault();
    void supervisor.stop().finally(() => {
      supervisor = undefined;
      router.setClient(undefined);
      app.exit(exitCode);
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
