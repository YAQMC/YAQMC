import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const smoke = process.env.YAQMC_DESKTOP_SMOKE === '1';

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

app.whenReady().then(() => {
  const window = createMainWindow();
  if (smoke) {
    window.webContents.once('did-finish-load', () => {
      app.quit();
    });
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
