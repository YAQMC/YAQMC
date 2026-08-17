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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANNEL_APP_OPEN_SETTINGS,
  CHANNEL_HOST_CORE_STATUS,
  CHANNEL_LYRICS_DOCUMENT,
  CHANNEL_LYRICS_PROJECTION,
  CHANNEL_LYRICS_SURFACE_CLOSED,
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
} from './ipc/host-handlers';
import { IpcRouter } from './ipc/router';
import { linuxGraphicsSwitches } from './linux-graphics';
import { APP_SCHEME, appIndexUrl, serveAppUrl } from './protocol';
import { applyAppWindowGuards, applySessionSecurity, VITE_DEV_ORIGIN } from './security';
import { registerGlobalShortcuts, unregisterGlobalShortcuts } from './services/shortcuts';
import { createTray, shouldHideInsteadOfClose, type TrayHandle } from './services/tray';
import { acquireSingleInstanceLock } from './single-instance';
import {
  createLyricsSurfaces,
  lyricsSurfaceSettingsFromCore,
  type LyricsSurfaceCreateOptions,
  type LyricsSurfaceKind,
} from './windows/lyrics-surfaces';
import {
  createLyricsUnlockOverlays,
  type LyricsUnlockCreateOptions,
  type LyricsUnlockKind,
} from './windows/lyrics-unlock';

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

function applyLinuxGraphicsSwitches(): void {
  const flags = linuxGraphicsSwitches({
    platform: process.platform,
    wayland: Boolean(process.env.WAYLAND_DISPLAY),
    nvidia: false,
    mode: process.env.YAQMC_LINUX_RENDERER ?? 'auto',
  });
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
const desktopRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(desktopRoot, '../..');
const harnessRoot = path.join(desktopRoot, 'harness');
const viteDist = path.join(repoRoot, 'dist');
const preloadPath = path.join(here, '../preload/main.cjs');
const lyricsPreloadPath = path.join(here, '../preload/lyrics-surface.cjs');
const unlockPreloadPath = path.join(here, '../preload/unlock-overlay.cjs');
const resourcesDir = path.join(desktopRoot, 'resources');
const nativeWayland = isNativeWaylandSession();

let supervisor: CoreSupervisor | undefined;
let stopping = false;
let exitCode = 0;
let mainWindow: BrowserWindow | undefined;
let trayHandle: TrayHandle | undefined;
/** FACT default: hide-to-tray. Preference read is cached; missing prefs stay hide. */
let closeToTray = true;

const lyricsSurfaces = createLyricsSurfaces({
  preloadPath: lyricsPreloadPath,
  createWindow: createLyricsBrowserWindow,
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
});

const lyricsUnlock = createLyricsUnlockOverlays({
  preloadPath: unlockPreloadPath,
  createWindow: createUnlockBrowserWindow,
});

const router = new IpcRouter({
  methods: loadMethodAclFromFile(
    path.join(repoRoot, 'packages/yaqmc-client/fixtures/methods.json'),
  ),
  hostHandlers: createHostHandlers({
    openExternal: (url) => shell.openExternal(url),
    lyrics: lyricsSurfaces,
    unlock: lyricsUnlock,
    capabilities: () =>
      lyricsSurfaceCapabilities({ platform: process.platform, nativeWayland }),
    showMainAndOpenSettings: emitOpenSettings,
    emitSurfaceClosed: (kind: LyricsSurfaceKind) => {
      fanoutEvent(CHANNEL_LYRICS_SURFACE_CLOSED, kind);
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
  }),
});

function rendererRoot(): string {
  if (smoke) {
    return harnessRoot;
  }
  if (existsSync(path.join(viteDist, 'index.html'))) {
    return viteDist;
  }
  return harnessRoot;
}

function mainWindowUrl(root: string): string {
  if (!app.isPackaged && process.env.YAQMC_VITE_DEV === '1') {
    return `${VITE_DEV_ORIGIN}/`;
  }
  if (root === viteDist) {
    return appIndexUrl('?provider=fake');
  }
  return appIndexUrl();
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

function emitOpenSettings(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  }
  fanoutEvent(CHANNEL_APP_OPEN_SETTINGS, null);
}

function createLyricsBrowserWindow(options: LyricsSurfaceCreateOptions) {
  const { alwaysOnTop, ...rest } = options;
  void alwaysOnTop;
  const window = new BrowserWindow({
    ...rest,
    alwaysOnTop: true,
  });
  const contentsId = window.webContents.id;
  router.registerWindow(contentsId, lyricsRoleFromCreateOptions(options));
  applyAppWindowGuards(window, {
    allowViteDevServer: !app.isPackaged && process.env.YAQMC_VITE_DEV === '1',
  });
  window.on('closed', () => {
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
  });
  const contentsId = window.webContents.id;
  router.registerWindow(contentsId, lyricsUnlockRoleFromKind(kind));
  applyAppWindowGuards(window, {
    allowViteDevServer: !app.isPackaged && process.env.YAQMC_VITE_DEV === '1',
  });
  window.on('closed', () => {
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
  if (channel === CHANNEL_PREFERENCES_CHANGED) {
    closeToTray = rememberCloseToTray(payload, closeToTray);
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
    })
    .catch(() => {
      // FACT: preference read deferred / failed → keep default hide-to-tray.
    });
}

function attachSupervisor(instance: CoreSupervisor): void {
  instance.on('status', (payload: CoreStatusPayload) => {
    fanoutEvent(CHANNEL_HOST_CORE_STATUS, payload);
  });
  instance.on('ready', (info: { restart: boolean }) => {
    router.setClient(instance.client);
    bindCoreEvents();
    cacheCloseToTrayPreference();
    void lyricsSurfaces.restoreGeometry();
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

function startSupervisor(): Promise<void> {
  const launch = resolveCoreLaunch({
    env: process.env,
    stagedDir: path.join(desktopRoot, 'resources', 'core'),
    resourcesPath: process.resourcesPath,
    cargoTargetDir: process.env.CARGO_TARGET_DIR,
    repoRoot,
  });
  if (!launch) {
    if (smoke) {
      throw new Error(
        'yaqmc-core binary was not found (set YAQMC_CORE_BIN or stage resources/core)',
      );
    }
    return Promise.resolve();
  }
  const tempRoot = path.join(app.getPath('temp'), 'yaqmc-core');
  const paths = smoke
    ? {
        dataDir: path.join(tempRoot, 'data'),
        cacheDir: path.join(tempRoot, 'cache'),
        logDir: path.join(tempRoot, 'logs'),
        configDir: path.join(tempRoot, 'config'),
      }
    : resolveCorePaths();
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

function installTrayAndShortcuts(): void {
  if (smoke) {
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
    });
  } catch (error) {
    console.warn('tray unavailable', error);
    trayHandle = undefined;
  }

  registerGlobalShortcuts({
    globalShortcut,
    invokePlayer,
    platform: process.platform,
    wayland: nativeWayland,
    log: {
      warn(message, extra) {
        console.warn(message, extra);
      },
    },
  });
}

function teardownHostChrome(): void {
  unregisterGlobalShortcuts(globalShortcut);
  trayHandle?.destroy();
  trayHandle = undefined;
}

ipcMain.handle(INVOKE_CHANNEL, async (event, request: InvokeRequest) => {
  return router.invoke(event.sender.id, request);
});

if (acquireSingleInstanceLock(app, () => mainWindow)) {
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
    installTrayAndShortcuts();
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
