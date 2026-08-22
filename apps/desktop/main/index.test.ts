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
    expect(source).toContain("from './windows/windows-occlusion'");
    expect(source).toContain("from './windows/ui-perf-diag'");
    expect(source).toContain('lyrics-surface.cjs');
    expect(source).toContain('unlock-overlay.cjs');
    expect(source).toContain('createTray');
    expect(source).toContain('trayLabelsForLocale');
    expect(source).toContain('applyTrayLabelsFromPreferences');
    expect(source).toContain('lastPreferencesRaw');
    expect(source).toContain('labels: trayLabelsForLocale(');
    expect(source).toContain('createGlobalShortcutSession');
    expect(source).toContain('applyShortcutsFromPreferences');
    expect(source).toContain('setShortcutsEnabled');
    expect(source).toContain('createLyricsSurfaces');
    expect(source).toContain('createLyricsUnlockOverlays');
    expect(source).toContain('linuxGraphicsSwitches');
    expect(source).toContain('windowsOcclusionSwitches');
    expect(source).toContain('linuxGraphicsDiagnostics');
    expect(source).toContain('platformFacts');
    expect(source).toContain('probeLinuxDisplayBackend');
    expect(source).toContain('isNativeWaylandDisplayBackend');
    expect(source).toContain('liveDisplayBackend');
    expect(source).toContain('readLinuxFdTargets');
    expect(source).toContain("getSwitchValue('ozone-platform')");
    expect(source).toContain("=== 'native-wayland' ? 'wayland'");
    expect(source).toContain('shortcutsEnabledFromPreferences');
    expect(source).toContain('trayError');
    expect(source).toContain('collectDiagnosticsHostPayload');
    expect(source).toContain('shell.openExternal');
    expect(source).toContain('shell.openPath');
    expect(source).toContain('showItemInFolder');
    expect(source).toContain('diagnostics_open_log_folder');
    expect(source).toContain('dialog.showSaveDialog');
    expect(source).toContain('dialog.showOpenDialog');
    expect(source).toContain('window.minimize');
    expect(source).toContain('host.coreStatus');
    expect(source).toContain('hostWindowChrome');
  });

  it('skips tray and shortcuts during YAQMC_DESKTOP_SMOKE', () => {
    expect(source).toContain("process.env.YAQMC_DESKTOP_SMOKE === '1'");
    expect(source).toContain('installTrayAndShortcuts');
    expect(source).toContain("YAQMC_E2E_TRAY !== '1'");
    expect(source).toMatch(
      /if \(smoke \|\| \(e2e && process\.env\.YAQMC_E2E_TRAY !== '1'\)\) \{\s*return;/,
    );
  });

  it('isolates Playwright _electron from the smoke harness and live profile', () => {
    expect(source).toContain("process.env.YAQMC_ELECTRON_E2E === '1'");
    expect(source).toContain('requireQaSandboxFromEnv');
    expect(source).toContain("process.env.YAQMC_UI_PERF_DIAG !== '1'");
    expect(source).toContain('qaSandbox.electronUserData');
    expect(source).toContain('qaSandbox.corePaths');
    expect(source).toContain('coreTempEnv(qaSandbox)');
    expect(source).not.toContain('yaqmc-electron-e2e');
    expect(source).not.toContain('yaqmc-ui-perf-diag');
    expect(source).toContain('${VITE_DEV_ORIGIN}/?provider=fake');
    expect(source).toContain('?surface=${kind}');
    expect(source).toContain('?unlockSurface=${kind}');
    expect(source).toContain("YAQMC_E2E_NATIVE === '1'");
    expect(source).toContain('e2e && !e2eNative');
    expect(source).toContain("YAQMC_E2E_CORE !== '1'");
    expect(source).toContain('__YAQMC_E2E__');
    expect(source).toContain('lyricsIsLocked');
    expect(source).toContain('lyricsIsVisible');
    expect(source).toContain('pushCoreStatus');
    expect(source).toContain('pushSurfaceInteraction');
    expect(source).toContain('CHANNEL_LYRICS_SURFACE_INTERACTION');
    expect(source).toContain('killRunningChild');
    expect(source).toContain('runningChildPid');
    expect(source).toContain('mainHide');
    expect(source).toContain('corePid');
    expect(source).toContain('coreDataDir');
    expect(source).toContain('secondInstanceHits');
    expect(source).toContain('trayClick');
    expect(source).toContain('openSettingsHits');
    expect(source).toContain('lastPlayerSnapshot');
    expect(source).toContain('coreInvoke');
    expect(source).toContain('flushGeometry');
    expect(source.indexOf('acquireSingleInstanceLock')).toBeGreaterThan(-1);
    expect(source.indexOf('acquireSingleInstanceLock')).toBeLessThan(
      source.indexOf('app.whenReady()'),
    );
  });

  it('throttles hidden Desktop/Island/unlock renderers without touching the main window clock', () => {
    expect(source).toContain('bindOverlayVisibilityThrottle');
    expect(source).toContain('setBackgroundThrottling(!visible)');
    expect(source).toContain("window.webContents.on('did-finish-load', apply);");
    expect(source).toContain('OVERLAY_VISUAL_DOCUMENT_GUARD');
    expect(source).toContain('${OVERLAY_VISUAL_DOCUMENT_GUARD}');
    const lyricsBind = source.indexOf('function createLyricsBrowserWindow');
    const unlockBind = source.indexOf('function createUnlockBrowserWindow');
    const mainBind = source.indexOf('function createMainWindow');
    expect(
      source.indexOf('bindOverlayVisibilityThrottle(window, role);', lyricsBind),
    ).toBeGreaterThan(lyricsBind);
    expect(source.indexOf('bindOverlayVisibilityThrottle(window, role);', lyricsBind)).toBeLessThan(
      unlockBind,
    );
    expect(
      source.indexOf(
        'bindOverlayVisibilityThrottle(window, lyricsUnlockRoleFromKind(kind));',
        unlockBind,
      ),
    ).toBeGreaterThan(unlockBind);
    expect(
      source.indexOf(
        'bindOverlayVisibilityThrottle(window, lyricsUnlockRoleFromKind(kind));',
        unlockBind,
      ),
    ).toBeLessThan(mainBind);
    expect(source.indexOf('bindOverlayVisibilityThrottle(', mainBind)).toBe(-1);
    expect(source.indexOf("backgroundColor: '#00000000'", lyricsBind)).toBeGreaterThan(lyricsBind);
    expect(source.indexOf("backgroundColor: '#00000000'", lyricsBind)).toBeLessThan(mainBind);
    expect(source.indexOf("backgroundColor: '#00000000'", mainBind)).toBe(-1);
    expect(source.slice(unlockBind, mainBind)).toContain('Unparented on purpose');
    expect(source.slice(unlockBind, mainBind)).not.toMatch(/\bparent\s*:/);
  });

  it('applies Linux graphics switches before ready and never sandbox/web-security flags', () => {
    const forbidden = [['--', 'no-sandbox'].join(''), ['--', 'disable-web-security'].join('')];
    expect(source).toContain('app.commandLine.appendSwitch');
    expect(source.indexOf('applyLinuxGraphicsSwitches();')).toBeGreaterThan(-1);
    expect(source.indexOf('applyLinuxGraphicsSwitches();')).toBeLessThan(
      source.indexOf('app.whenReady()'),
    );
    expect(source.indexOf('applyWindowsOcclusionSwitches();')).toBeGreaterThan(-1);
    expect(source.indexOf('applyWindowsOcclusionSwitches();')).toBeLessThan(
      source.indexOf('app.whenReady()'),
    );
    expect(source).toContain('windowsOcclusionSwitches');
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
    expect(source).toContain('emitOpenSettings');
    expect(source).toContain('openSettings: emitOpenSettings');
    expect(source).toContain('invokePlayer');
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
    expect(source).toContain(
      'function invokeOAuthCore(method: string, params?: unknown, origin?: string)',
    );
    expect(source).toContain('return client.invoke(method, params, origin);');
    expect(source).toContain('supervisor start binary=');
    expect(source).not.toContain('openOAuthWindow');
    expect(source).toContain('oauth BrowserWindow is disabled during YAQMC_DESKTOP_SMOKE');
    expect(source).not.toContain("from './dialogs'");
    expect(source).toContain("from './services/updater'");
    expect(source).toContain("from './services/electron-updater-port'");
    expect(source).toContain('createUpdater');
    expect(source).toContain('collectLiveHostPayload');
    expect(source).toContain('createHostLog');
    expect(source).toContain('host.log');
    expect(source).toContain('scheduleLaunchCheck');
    expect(source).toContain('app.isPackaged');
    expect(source).toContain('packaged: app.isPackaged');
    expect(source).toContain('dataDir: () => coreDataPaths().dataDir');
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

  it('loads the packaged IPC ACL from extraResources instead of the source tree', () => {
    expect(source).toContain('const methodAclPath = app.isPackaged');
    expect(source).toContain("process.resourcesPath, 'contract', 'methods.json'");
    expect(source).toContain("'packages/yaqmc-client/fixtures/methods.json'");
    expect(source).toContain('loadMethodAclFromFile(methodAclPath)');
  });

  it('does not scrape every WebContents console-message', () => {
    expect(source).not.toContain('console-message');
  });
});
