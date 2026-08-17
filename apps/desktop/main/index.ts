import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoreClient } from './core/client';
import { CoreSupervisor, tryResolveCoreBinary } from './core/supervisor';
import { EVENT_CHANNEL, INVOKE_CHANNEL, handleRendererInvoke, type InvokeRequest } from './ipc';
import { APP_SCHEME, appIndexUrl, serveAppUrl } from './protocol';

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

let supervisor: CoreSupervisor | undefined;
let coreClient: CoreClient | undefined;
let stopping = false;
let exitCode = 0;

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
  void window.loadURL(mainWindowUrl(root));
  return window;
}

function bindCoreEvents(client: CoreClient): void {
  client.on('event', (frame: { channel: string; payload: unknown }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(EVENT_CHANNEL, {
        channel: frame.channel,
        payload: frame.payload,
      });
    }
  });
}

function startSupervisor(): Promise<void> {
  const binary = tryResolveCoreBinary({
    env: process.env,
    stagedDir: path.join(desktopRoot, 'resources', 'core'),
    resourcesPath: process.resourcesPath,
    cargoTargetDir: process.env.CARGO_TARGET_DIR,
    repoRoot,
  });
  if (!binary) {
    if (smoke) {
      throw new Error('yaqmc-core binary was not found (set YAQMC_CORE_BIN or stage resources/core)');
    }
    return Promise.resolve();
  }
  const coreRoot = path.join(app.getPath('temp'), 'yaqmc-core');
  supervisor = new CoreSupervisor({
    binary,
    dataDir: path.join(coreRoot, 'data'),
    cacheDir: path.join(coreRoot, 'cache'),
    logDir: path.join(coreRoot, 'logs'),
    configDir: path.join(coreRoot, 'config'),
    hostVersion: app.getVersion(),
    expectedCoreVersion: app.getVersion(),
  });
  return supervisor.start().then(() => {
    coreClient = supervisor?.client;
    if (coreClient) {
      bindCoreEvents(coreClient);
    }
  });
}

ipcMain.handle(INVOKE_CHANNEL, async (_event, request: InvokeRequest) => {
  return handleRendererInvoke(coreClient, request);
});

app.whenReady().then(async () => {
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
  const window = createMainWindow(root);
  if (smoke) {
    window.webContents.on('did-fail-load', (_event, code, description) => {
      console.error(`harness failed to load: ${code} ${description}`);
      quitWith(1);
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      console.error(`harness renderer gone: ${details.reason}`);
      quitWith(1);
    });
    window.webContents.on('page-title-updated', (_event, title) => {
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
    coreClient = undefined;
    app.exit(exitCode);
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
