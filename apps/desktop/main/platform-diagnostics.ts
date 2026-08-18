/**
 * Overlay host-observed tray / window-backend facts onto Core
 * `platform_diagnostics`. Core owns audio and MPRIS; Main owns the tray.
 * Linux display backend is probed (Ozone switch + client sockets), not inferred
 * from DISPLAY being set on a Wayland session.
 */

import { readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { FACT_SHORTCUT_ACCELERATORS } from './services/shortcuts';

export type HostPlatformFacts = {
  displayBackend: string;
  graphicsMode: string;
  trayAvailable: boolean;
  trayError: string | null;
  globalShortcutsSupported: boolean;
  globalShortcutsEnabled: boolean;
};

export type LinuxDisplayProbe = {
  /** Live `--ozone-platform` switch, if Chromium selected or the host set one. */
  ozonePlatform?: string | null;
  /** `readlink` targets from `/proc/self/fd`. */
  fdTargets: readonly string[];
  waylandDisplay?: string | null;
  x11Display?: string | null;
};

export function readLinuxFdTargets(fdDir = `/proc/${process.pid}/fd`): string[] {
  try {
    return readdirSync(fdDir).flatMap((name) => {
      try {
        return [readlinkSync(path.join(fdDir, name))];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function probeLinuxDisplayBackend(probe: LinuxDisplayProbe): string {
  const ozone = canonicalOzone(probe.ozonePlatform);
  const waylandSession = hasText(probe.waylandDisplay);
  const waylandClient = fdTargetsHaveWayland(probe.fdTargets, probe.waylandDisplay);
  const x11Client = fdTargetsHaveX11(probe.fdTargets);

  if (waylandClient) {
    return 'wayland-native';
  }
  // Explicit Ozone Wayland is the window backend even if an X11 client
  // socket is also open (DISPLAY leftover, or /proc fd path missing).
  if (ozone === 'wayland') {
    return 'wayland-native';
  }
  if (x11Client) {
    return waylandSession ? 'xwayland' : 'x11';
  }

  if (ozone === 'x11') {
    return waylandSession ? 'xwayland' : 'x11';
  }

  // No client sockets and no Ozone selection. Session env is not a window backend.
  if (waylandSession && !hasText(probe.x11Display)) {
    return 'wayland-native';
  }
  if (waylandSession) {
    return 'unavailable';
  }
  return hasText(probe.x11Display) ? 'x11' : 'unavailable';
}

export function isNativeWaylandDisplayBackend(backend: string): boolean {
  return backend === 'wayland-native' || backend === 'wayland';
}

export function capabilitiesForBackend(
  backend: string,
  globalShortcutsSupported: boolean,
): Record<string, unknown> {
  if (isNativeWaylandDisplayBackend(backend)) {
    return {
      reliableAlwaysOnTop: false,
      clickThrough: false,
      transparentWindow: false,
      globalPositioning: false,
      absoluteWindowPlacement: false,
      fullscreenDetection: false,
      globalShortcuts: false,
      notes: [
        'Native Wayland intentionally does not promise X11-style overlay placement, click-through or always-on-top semantics.',
        'Media keys remain available through MPRIS; configurable global shortcuts use an X11 backend and are disabled for native Wayland.',
      ],
    };
  }
  return {
    reliableAlwaysOnTop: true,
    clickThrough: true,
    transparentWindow: true,
    globalPositioning: true,
    absoluteWindowPlacement: true,
    fullscreenDetection: backend === 'windows',
    globalShortcuts: globalShortcutsSupported,
    notes:
      backend === 'xwayland'
        ? [
            'The desktop session is Wayland, but YAQMC is using an X11/XWayland window backend.',
          ]
        : [],
  };
}

export function shortcutsEnabledFromPreferences(raw: unknown): boolean {
  const document = preferencesObject(raw);
  const system = document?.system;
  if (!system || typeof system !== 'object') {
    return false;
  }
  return (system as { globalShortcutsEnabled?: unknown }).globalShortcutsEnabled === true;
}

export function desktopIntegrationFromFacts(facts: HostPlatformFacts): {
  trayAvailable: boolean;
  trayError: string | null;
  globalShortcutsSupported: boolean;
  globalShortcutsEnabled: boolean;
  globalShortcuts: string[];
  shortcutError: null;
} {
  return {
    trayAvailable: facts.trayAvailable,
    trayError: facts.trayError,
    globalShortcutsSupported: facts.globalShortcutsSupported,
    globalShortcutsEnabled: facts.globalShortcutsEnabled,
    globalShortcuts: [...FACT_SHORTCUT_ACCELERATORS],
    shortcutError: null,
  };
}

const LINUX_DISPLAY_BACKENDS = new Set([
  'wayland',
  'wayland-native',
  'xwayland',
  'x11',
  'unavailable',
]);

export function overlayPlatformDiagnostics(
  core: unknown,
  facts: HostPlatformFacts,
): Record<string, unknown> {
  const diagnostics = isRecord(core) ? { ...core } : {};
  if (isRecord(diagnostics.linux) || LINUX_DISPLAY_BACKENDS.has(facts.displayBackend)) {
    const linux = isRecord(diagnostics.linux) ? { ...diagnostics.linux } : {};
    linux.displayBackend = facts.displayBackend;
    linux.graphicsMode = facts.graphicsMode;
    linux.webkitgtkVersion = null;
    diagnostics.linux = linux;
    diagnostics.capabilities = capabilitiesForBackend(
      facts.displayBackend,
      facts.globalShortcutsSupported,
    );
  }
  diagnostics.desktopIntegration = desktopIntegrationFromFacts(facts);
  return diagnostics;
}

function canonicalOzone(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function hasText(value: string | null | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

function normalizeFdTarget(target: string): string {
  return target.replace(/^unix:/, '').replace(/^@/, '');
}

function waylandSocketBasename(waylandDisplay: string | null | undefined): string | undefined {
  if (!hasText(waylandDisplay)) {
    return undefined;
  }
  const trimmed = waylandDisplay!.trim();
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function fdTargetsHaveWayland(
  targets: readonly string[],
  waylandDisplay?: string | null,
): boolean {
  const basename = waylandSocketBasename(waylandDisplay);
  return targets.some((target) => {
    const normalized = normalizeFdTarget(target);
    if (normalized.endsWith('.lock')) {
      return false;
    }
    if (basename && (normalized === basename || normalized.endsWith(`/${basename}`))) {
      return true;
    }
    return /(?:^|\/)wayland-\d+$/.test(normalized);
  });
}

export function fdTargetsHaveX11(targets: readonly string[]): boolean {
  return targets.some((target) => {
    const normalized = normalizeFdTarget(target);
    return normalized.includes('.X11-unix') || /(?:^|\/)X\d+$/.test(normalized);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function preferencesObject(raw: unknown): { system?: unknown } | undefined {
  const document =
    raw &&
    typeof raw === 'object' &&
    'value' in raw &&
    typeof (raw as { value?: unknown }).value === 'string'
      ? (raw as { value: string }).value
      : raw;
  if (typeof document === 'string') {
    try {
      return JSON.parse(document) as { system?: unknown };
    } catch {
      return undefined;
    }
  }
  if (document && typeof document === 'object') {
    return document as { system?: unknown };
  }
  return undefined;
}
