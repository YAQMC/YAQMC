import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'),
  'utf8',
);

describe('host boot wiring', () => {
  it('imports tray, shortcuts, opener, lyrics surfaces, unlock overlays, and graphics policy', () => {
    expect(source).toContain("from './services/tray'");
    expect(source).toContain("from './services/shortcuts'");
    expect(source).toContain("from './ipc/host-handlers'");
    expect(source).toContain("from './windows/lyrics-surfaces'");
    expect(source).toContain("from './windows/lyrics-unlock'");
    expect(source).toContain("from './windows/surface-auto-hide'");
    expect(source).toContain("from './host-commands'");
    expect(source).toContain("from './linux-graphics'");
    expect(source).toContain('lyrics-surface.cjs');
    expect(source).toContain('unlock-overlay.cjs');
    expect(source).toContain('createTray');
    expect(source).toContain('trayLabelsForLocale');
    expect(source).toContain('applyTrayLabelsFromPreferences');
    expect(source).toContain('registerGlobalShortcuts');
    expect(source).toContain('createLyricsSurfaces');
    expect(source).toContain('createLyricsUnlockOverlays');
    expect(source).toContain('linuxGraphicsSwitches');
    expect(source).toContain('linuxGraphicsDiagnostics');
    expect(source).toContain('collectDiagnosticsHostPayload');
    expect(source).toContain('shell.openExternal');
    expect(source).toContain('dialog.showSaveDialog');
    expect(source).toContain('dialog.showOpenDialog');
  });

  it('skips tray and shortcuts during YAQMC_DESKTOP_SMOKE', () => {
    expect(source).toContain("process.env.YAQMC_DESKTOP_SMOKE === '1'");
    expect(source).toContain('installTrayAndShortcuts');
    expect(source).toMatch(/if \(smoke\) \{\s*return;/);
  });

  it('applies Linux graphics switches before ready and never sandbox/web-security flags', () => {
    const forbidden = [['--', 'no-sandbox'].join(''), ['--', 'disable-web-security'].join('')];
    expect(source).toContain('app.commandLine.appendSwitch');
    expect(source.indexOf('applyLinuxGraphicsSwitches();')).toBeGreaterThan(-1);
    expect(source.indexOf('applyLinuxGraphicsSwitches();')).toBeLessThan(
      source.indexOf('app.whenReady()'),
    );
    expect(source).toContain('process.platform');
    for (const flag of forbidden) {
      expect(source).not.toContain(flag);
    }
  });

  it('keeps the main window FACT size and sandbox flags', () => {
    expect(source).toContain('width: 1280');
    expect(source).toContain('height: 800');
    expect(source).toContain('sandbox: true');
    expect(source).toContain('contextIsolation: true');
    expect(source).toContain('nodeIntegration: false');
    expect(source).not.toContain(['--', 'no-sandbox'].join(''));
  });

  it('restores lyric surface geometry after core ready using BASE-04 keys', () => {
    expect(source).toContain('lyricsSurfaceSettingsFromCore');
    expect(source).toContain('restoreGeometry');
    expect(source).toContain('getDisplayBounds');
    expect(source).toContain('screen.getAllDisplays');
    expect(source).toContain('lyrics-surface-geometry:desktop');
    expect(source).toContain('lyrics-surface-geometry:island');
    expect(source.indexOf('void lyricsSurfaces.restoreGeometry();')).toBeGreaterThan(
      source.indexOf("instance.on('ready'"),
    );
  });

  it('subscribes host://command and sends platform_attach after ready', () => {
    expect(source).toContain('subscribeSurfaceAutoHide');
    expect(source).toContain('subscribeHostCommands');
    expect(source).toContain('quitFromHostCommand');
    expect(source).toContain('sendPlatformAttach');
    expect(source).toContain("invoke('platform_attach'");
    expect(source).toContain('getNativeWindowHandle');
    expect(source).toContain('buildPlatformAttach');
    expect(
      source.indexOf('subscribeSurfaceAutoHide(instance.client, lyricsSurfaces);'),
    ).toBeGreaterThan(source.indexOf("instance.on('ready'"));
    expect(source.indexOf('sendPlatformAttach();')).toBeGreaterThan(
      source.indexOf("instance.on('ready'"),
    );
    expect(source).not.toContain('qqmusic_auth_oauth_start');
  });

  it('wires OAuth factories without auto-opening a window at boot', () => {
    expect(source).toContain('session.fromPartition');
    expect(source).toContain('createOAuthBrowserWindow');
    expect(source).toContain('invokeOAuthCore');
    expect(source).not.toContain('openOAuthWindow');
    expect(source).toContain('oauth BrowserWindow is disabled during YAQMC_DESKTOP_SMOKE');
    expect(source).not.toContain("from './dialogs'");
    expect(source).toContain("from './services/updater'");
    expect(source).toContain("from './services/electron-updater-port'");
    expect(source).toContain('createUpdater');
    expect(source).toContain('collectLiveHostPayload');
    expect(source).toContain('scheduleLaunchCheck');
    expect(source).toContain('app.isPackaged');
    const oauthFromPartition = source.slice(
      source.indexOf('fromPartition:'),
      source.indexOf('isPackaged:'),
    );
    expect(oauthFromPartition).toContain('session.fromPartition');
    expect(oauthFromPartition).toContain('applySessionSecurity');
    const oauthWindow = source.slice(
      source.indexOf('function createOAuthBrowserWindow'),
      source.indexOf('function quitFromHostCommand'),
    );
    expect(oauthWindow).not.toContain('applyAppWindowGuards');
  });

  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });

  it('serves the packaged Vite renderer from extraResources, not fake-mode', () => {
    expect(source).toContain("process.resourcesPath, 'renderer'");
    expect(source).toContain('packagedRendererRoot');
    expect(source).toContain('!app.isPackaged && root === viteDist');
    expect(source).not.toContain(
      "if (root === viteDist) {\n    return appIndexUrl('?provider=fake');",
    );
  });
});
