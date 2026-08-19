import { describe, expect, it } from 'vitest';
import { FACT_SHORTCUT_ACCELERATORS } from './services/shortcuts';
import {
  capabilitiesForBackend,
  desktopIntegrationFromFacts,
  fdTargetsHaveWayland,
  fdTargetsHaveX11,
  isNativeWaylandDisplayBackend,
  overlayPlatformDiagnostics,
  probeLinuxDisplayBackend,
  shortcutsEnabledFromPreferences,
  type HostPlatformFacts,
} from './platform-diagnostics';

const waylandSession = {
  waylandDisplay: 'wayland-1',
  x11Display: ':1',
};

const nativeFacts: HostPlatformFacts = {
  displayBackend: 'wayland-native',
  graphicsMode: 'auto',
  trayAvailable: true,
  trayError: null,
  globalShortcutsSupported: false,
  globalShortcutsEnabled: false,
};

describe('probeLinuxDisplayBackend', () => {
  it('reports wayland-native when the process is a Wayland client, even if DISPLAY is set', () => {
    expect(
      probeLinuxDisplayBackend({
        ...waylandSession,
        fdTargets: ['/run/user/1000/wayland-1', 'anon_inode:[eventfd]'],
      }),
    ).toBe('wayland-native');
  });

  it('reports xwayland only when the process is an X11 client on a Wayland session', () => {
    expect(
      probeLinuxDisplayBackend({
        ...waylandSession,
        fdTargets: ['/tmp/.X11-unix/X1', 'pipe:[123]'],
      }),
    ).toBe('xwayland');
  });

  it('does not treat DISPLAY as proof of an XWayland window', () => {
    expect(
      probeLinuxDisplayBackend({
        ...waylandSession,
        fdTargets: ['pipe:[1]', 'anon_inode:[eventfd]'],
      }),
    ).toBe('unavailable');
  });

  it('treats explicit ozone wayland as native even when an X11 socket is also open', () => {
    expect(
      probeLinuxDisplayBackend({
        ...waylandSession,
        ozonePlatform: 'wayland',
        fdTargets: ['unix:/tmp/.X11-unix/X1', 'socket:[12]'],
      }),
    ).toBe('wayland-native');
  });

  it('uses the live ozone-platform switch when sockets do not decide', () => {
    expect(
      probeLinuxDisplayBackend({
        ...waylandSession,
        ozonePlatform: 'wayland',
        fdTargets: [],
      }),
    ).toBe('wayland-native');
    expect(
      probeLinuxDisplayBackend({
        ...waylandSession,
        ozonePlatform: 'x11',
        fdTargets: [],
      }),
    ).toBe('xwayland');
  });

  it('reports x11 when only an X11 client connection exists', () => {
    expect(
      probeLinuxDisplayBackend({
        waylandDisplay: null,
        x11Display: ':0',
        fdTargets: ['@/tmp/.X11-unix/X0'],
      }),
    ).toBe('x11');
  });
});

describe('fd socket matching', () => {
  it('matches the session Wayland socket and ignores lock files', () => {
    expect(
      fdTargetsHaveWayland(
        ['/run/user/1000/wayland-1.lock', '/run/user/1000/wayland-1'],
        'wayland-1',
      ),
    ).toBe(true);
    expect(fdTargetsHaveWayland(['/run/user/1000/wayland-1.lock'], 'wayland-1')).toBe(false);
    expect(fdTargetsHaveX11(['unix:/tmp/.X11-unix/X0', 'socket:[9]'])).toBe(true);
  });
});

describe('capabilitiesForBackend', () => {
  it('degrades only native Wayland, not a probed XWayland client', () => {
    const xwayland = capabilitiesForBackend('xwayland', true);
    expect(xwayland.reliableAlwaysOnTop).toBe(true);
    expect(xwayland.notes).toEqual([
      'The desktop session is Wayland, but YAQMC is using an X11/XWayland window backend.',
    ]);
    const native = capabilitiesForBackend('wayland-native', true);
    expect(native.reliableAlwaysOnTop).toBe(false);
    expect(native.globalShortcuts).toBe(false);
    expect(capabilitiesForBackend('wayland', true).reliableAlwaysOnTop).toBe(false);
  });
});

describe('isNativeWaylandDisplayBackend', () => {
  it('accepts live probe and Core wayland tokens, not X11 or XWayland', () => {
    expect(isNativeWaylandDisplayBackend('wayland-native')).toBe(true);
    expect(isNativeWaylandDisplayBackend('wayland')).toBe(true);
    expect(isNativeWaylandDisplayBackend('xwayland')).toBe(false);
    expect(isNativeWaylandDisplayBackend('x11')).toBe(false);
  });
});

describe('shortcutsEnabledFromPreferences', () => {
  it('reads system.globalShortcutsEnabled from a raw document or wrapped value', () => {
    expect(shortcutsEnabledFromPreferences({ system: { globalShortcutsEnabled: true } })).toBe(
      true,
    );
    expect(
      shortcutsEnabledFromPreferences({
        value: JSON.stringify({ system: { globalShortcutsEnabled: true } }),
      }),
    ).toBe(true);
    expect(shortcutsEnabledFromPreferences({ system: {} })).toBe(false);
    expect(shortcutsEnabledFromPreferences(undefined)).toBe(false);
  });
});

describe('overlayPlatformDiagnostics', () => {
  it('keeps Core OS/audio/MPRIS and overlays the probed window backend plus tray', () => {
    const overlaid = overlayPlatformDiagnostics(
      {
        os: 'linux',
        linux: { displayBackend: 'unavailable', graphicsMode: 'gpu-off' },
        audio: { implementation: 'Rodio 0.22 / CPAL 0.17', available: true },
        systemMedia: { specification: 'MPRIS 2.2', available: true },
        desktopIntegration: { trayAvailable: false },
      },
      nativeFacts,
    );
    expect(overlaid.os).toBe('linux');
    expect(overlaid.linux).toMatchObject({
      displayBackend: 'wayland-native',
      graphicsMode: 'auto',
      webkitgtkVersion: null,
    });
    expect(overlaid.systemMedia).toEqual({ specification: 'MPRIS 2.2', available: true });
    expect(overlaid.desktopIntegration).toEqual({
      trayAvailable: true,
      trayError: null,
      globalShortcutsSupported: false,
      globalShortcutsEnabled: false,
      globalShortcuts: [...FACT_SHORTCUT_ACCELERATORS],
      shortcutError: null,
    });
    expect(overlaid.capabilities).toMatchObject({
      reliableAlwaysOnTop: false,
      globalShortcuts: false,
    });
  });

  it('does not invent a linux blob on Windows', () => {
    const overlaid = overlayPlatformDiagnostics(
      { os: 'windows', linux: null, capabilities: { fullscreenDetection: true } },
      {
        displayBackend: 'win32',
        graphicsMode: 'auto',
        trayAvailable: true,
        trayError: null,
        globalShortcutsSupported: true,
        globalShortcutsEnabled: false,
      },
    );
    expect(overlaid.linux).toBeNull();
    expect(overlaid.capabilities).toEqual({ fullscreenDetection: true });
    expect(overlaid.desktopIntegration).toEqual(
      desktopIntegrationFromFacts({
        displayBackend: 'win32',
        graphicsMode: 'auto',
        trayAvailable: true,
        trayError: null,
        globalShortcutsSupported: true,
        globalShortcutsEnabled: false,
      }),
    );
  });

  it('passes a live shortcutError through desktop integration facts', () => {
    const overlaid = overlayPlatformDiagnostics(
      { os: 'windows', linux: null },
      {
        displayBackend: 'win32',
        graphicsMode: 'auto',
        trayAvailable: true,
        trayError: null,
        globalShortcutsSupported: true,
        globalShortcutsEnabled: true,
        shortcutError: 'shortcut conflict for control+alt+Space',
      },
    );
    expect(overlaid.desktopIntegration).toEqual(
      expect.objectContaining({
        globalShortcutsEnabled: true,
        shortcutError: 'shortcut conflict for control+alt+Space',
      }),
    );
  });
});
