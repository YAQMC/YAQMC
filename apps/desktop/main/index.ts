import { app, BrowserWindow, ipcMain, protocol, session, webContents } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANNEL_HOST_CORE_STATUS,
  CHANNEL_LYRICS_DOCUMENT,
  CHANNEL_LYRICS_PROJECTION,
  CHANNEL_PLAYER_SNAPSHOT,
} from '@yaqmc/client';
import { resyncAfterCoreRestart } from './core/resync';
import { CoreSupervisor, resolveCoreLaunch, type CoreStatusPayload } from './core/supervisor';
import { resolveCorePaths } from './core/paths';
import { EVENT_CHANNEL, INVOKE_CHANNEL, type InvokeRequest } from './ipc';
import { loadMethodAclFromFile } from './ipc/channels';
import { IpcRouter } from './ipc/router';
import { APP_SCHEME, appIndexUrl, serveAppUrl } from './protocol';
import { applyAppWindowGuards, applySessionSecurity, VITE_DEV_ORIGIN } from './security';
import { acquireSingleInstanceLock } from './single-instance';

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

const here = path.dirname(fileURLToPath(import.meta.url));
const smoke = process.env.YAQMC_DESKTOP_SMOKE === '1';
const desktopRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(desktopRoot, '../..');
const harnessRoot = path.join(desktopRoot, 'harness');
const viteDist = path.join(repoRoot, 'dist');

const router = new IpcRouter({
  methods: loadMethodAclFromFile(
    path.join(repoRoot, 'packages/yaqmc-client/fixtures/methods.json'),
  ),
});

let supervisor: CoreSupervisor | undefined;
let stopping = false;
let exitCode = 0;
let mainWindow: BrowserWindow | undefined;

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
  if (!supervisor) {
    app.exit(code);
    return;
  }
  app.quit();
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
      preload: path.join(here, '../preload/main.cjs'),
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
  window.on('closed', () => {
    router.unregisterWindow(contentsId);
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });
  applyAppWindowGuards(window, {
    allowViteDevServer: !app.isPackaged && process.env.YAQMC_VITE_DEV === '1',
  });
  void window.loadURL(mainWindowUrl(root));
  return window;
}

function fanoutEvent(channel: string, payload: unknown): void {
  router.fanout(channel, payload, (id, eventFrame) => {
    webContents.fromId(id)?.send(EVENT_CHANNEL, eventFrame);
  });
}

function bindCoreEvents(): void {
  supervisor?.client.on('event', (frame: { channel: string; payload: unknown }) => {
    fanoutEvent(frame.channel, frame.payload);
  });
}

function attachSupervisor(instance: CoreSupervisor): void {
  instance.on('status', (payload: CoreStatusPayload) => {
    fanoutEvent(CHANNEL_HOST_CORE_STATUS, payload);
  });
  instance.on('ready', (info: { restart: boolean }) => {
    router.setClient(instance.client);
    bindCoreEvents();
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
    if (stopping || !supervisor) {
      return;
    }
    event.preventDefault();
    stopping = true;
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
