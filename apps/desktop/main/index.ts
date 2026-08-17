import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreSupervisor, tryResolveCoreBinary } from './core/supervisor';

const here = path.dirname(fileURLToPath(import.meta.url));
const smoke = process.env.YAQMC_DESKTOP_SMOKE === '1';
const desktopRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(desktopRoot, '../..');

let supervisor: CoreSupervisor | undefined;
let stopping = false;

function createMainWindow(): BrowserWindow {
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
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  void window.loadURL('about:blank');
  return window;
}

app.whenReady().then(async () => {
  if (!smoke) {
    const binary = tryResolveCoreBinary({
      env: process.env,
      stagedDir: path.join(desktopRoot, 'resources', 'core'),
      resourcesPath: process.resourcesPath,
      cargoTargetDir: process.env.CARGO_TARGET_DIR,
      repoRoot,
    });
    if (binary) {
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
      await supervisor.start();
    }
  }
  const window = createMainWindow();
  if (smoke) {
    window.webContents.once('did-finish-load', () => {
      app.quit();
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
    app.exit(0);
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
