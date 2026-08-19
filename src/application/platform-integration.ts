import { useCallback, useEffect, useState } from 'react';
import { isNativeRuntime } from './native-player-runtime';
import { getYaqmcClient } from './yaqmc-runtime';

const client = getYaqmcClient();

export interface PlatformCapabilities {
  reliableAlwaysOnTop: boolean;
  clickThrough: boolean;
  transparentWindow: boolean;
  globalPositioning: boolean;
  absoluteWindowPlacement: boolean;
  fullscreenDetection: boolean;
  globalShortcuts: boolean;
  notes: string[];
}

export interface DesktopIntegrationStatus {
  trayAvailable: boolean;
  trayError: string | null;
  globalShortcutsSupported: boolean;
  globalShortcutsEnabled: boolean;
  globalShortcuts: string[];
  shortcutError: string | null;
}

export interface PlatformDiagnostics {
  generatedAtUnixMs: number;
  appName: string;
  appVersion: string;
  os: string;
  architecture: string;
  linux: null | {
    sessionType: string | null;
    displayBackend: string;
    desktopEnvironment: string | null;
    compositorHint: string | null;
    webkitgtkVersion: string | null;
    graphicsMode: string;
    environment: Record<string, string | null>;
    gpuDevices: Array<{
      card: string;
      vendorId: string | null;
      deviceId: string | null;
      driver: string | null;
    }>;
  };
  capabilities: PlatformCapabilities;
  audio: {
    implementation: string;
    route: string;
    available: boolean;
    selectedOutput: string | null;
    selectedOutputKind: string | null;
    resolvedOutput: string | null;
    resolvedDriver: string | null;
    resolvedHost: string | null;
    resolvedSampleRate: number | null;
    resolvedChannels: number | null;
    resolvedSampleFormat: string | null;
  };
  systemMedia: {
    available: boolean;
    backend: string;
    specification: string;
    error: string | null;
  };
  desktopIntegration: DesktopIntegrationStatus;
}

let cachedDiagnostics: PlatformDiagnostics | null = null;

function applyPlatformAttributes(diagnostics: PlatformDiagnostics): void {
  const root = document.documentElement;
  root.dataset.platform = diagnostics.os;
  if (diagnostics.linux) {
    root.dataset.displayBackend = diagnostics.linux.displayBackend;
    root.dataset.graphicsMode = diagnostics.linux.graphicsMode;
  } else {
    delete root.dataset.displayBackend;
    delete root.dataset.graphicsMode;
  }
}

export async function readPlatformDiagnostics(): Promise<PlatformDiagnostics | null> {
  if (!isNativeRuntime) return null;
  const diagnostics = (await client.invoke('platform_diagnostics')) as PlatformDiagnostics;
  cachedDiagnostics = diagnostics;
  applyPlatformAttributes(diagnostics);
  return diagnostics;
}

export function isLinuxWebView(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.platform === 'linux';
}

export function skipsLiveCssBlur(): boolean {
  if (typeof document === 'undefined') return false;
  const platform = document.documentElement.dataset.platform;
  return platform === 'linux' || platform === 'windows';
}

export function linuxSkipsLiveVideo(): boolean {
  if (!isLinuxWebView()) return false;
  const mode = document.documentElement.dataset.graphicsMode;
  return mode === 'software' || mode === 'safe';
}

export function usePlatformDiagnosticsRuntime(): void {
  useEffect(() => {
    void readPlatformDiagnostics().catch(() => undefined);
  }, []);
}

export function usePlatformIntegration() {
  const [diagnostics, setDiagnostics] = useState<PlatformDiagnostics | null>(cachedDiagnostics);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportPath, setExportPath] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isNativeRuntime) return;
    setError(null);
    try {
      setDiagnostics(await readPlatformDiagnostics());
    } catch (caught) {
      setError(String(caught));
    }
  }, []);

  useEffect(() => {
    if (!isNativeRuntime) return;
    let active = true;
    void readPlatformDiagnostics()
      .then((value) => {
        if (active) setDiagnostics(value);
      })
      .catch((caught) => {
        if (active) setError(String(caught));
      });
    return () => {
      active = false;
    };
  }, []);

  const setGlobalShortcuts = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const status = await client.invoke('system_shortcuts_set_enabled', { enabled });
      setDiagnostics(await readPlatformDiagnostics());
      if (status.shortcutError) {
        setError(status.shortcutError);
      }
      return status.globalShortcutsEnabled === enabled;
    } catch (caught) {
      setError(String(caught));
      setDiagnostics(await readPlatformDiagnostics().catch(() => cachedDiagnostics));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const exportDiagnostics = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const path = await client.invoke('platform_export_diagnostics');
      setExportPath(path);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    available: isNativeRuntime,
    diagnostics,
    busy,
    error,
    exportPath,
    refresh,
    setGlobalShortcuts,
    exportDiagnostics,
  };
}
