import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostBridge } from '@yaqmc/client';
import type { BundleExportResult } from './diagnostics-runtime';

const hostMocks = vi.hoisted(() => {
  const invoke = vi.fn();
  const pickSave = vi.fn();
  const bridge = {
    kind: 'electron' as HostBridge['kind'],
    windowRole: 'main' as const,
    window: {
      minimize: async () => undefined,
      toggleMaximize: async () => undefined,
      close: async () => undefined,
      setFullscreen: async () => undefined,
    },
    shell: {
      openExternal: async () => undefined,
    },
    dialog: { pickSave },
    invoke,
    listen: () => () => undefined,
  };
  return { invoke, pickSave, bridge };
});

vi.mock('./yaqmc-runtime', async () => {
  const { YaqmcClient } = await import('@yaqmc/client');
  const client = new YaqmcClient(hostMocks.bridge as HostBridge);
  client.markReady();
  return {
    getHostBridge: () => hostMocks.bridge,
    getYaqmcClient: () => client,
  };
});

vi.mock('./native-player-runtime', () => ({
  isNativeRuntime: true,
}));

import {
  DIAGNOSTICS_ZIP_DEFAULT_NAME,
  DiagnosticsExportAbortedError,
  currentConsoleForwardMode,
  exportDiagnosticsBundle,
  setConsoleForwardPreference,
} from './diagnostics-runtime';
import { CONSOLE_FORWARD_SETTING_KEY, __testing as loggerTesting } from './logger';

function sampleBundle(path: string): BundleExportResult {
  return {
    path,
    bytes: 32,
    sha256: 'abc',
    redaction: {
      scannerVersion: 1,
      filesScanned: 0,
      valuesRedacted: 0,
      unresolvedPatterns: [],
    },
    warnings: [],
    manifest: {
      schemaVersion: 1,
      scannerVersion: 1,
      appName: 'YAQMC',
      appVersion: '0.1.0',
      platform: 'windows',
      architecture: 'x64',
      generatedAtUnixMs: 1,
      sessionId: 'session',
      logFiles: [],
      includeSnapshot: true,
      includeLogs: true,
    },
  };
}

describe('exportDiagnosticsBundle', () => {
  beforeEach(() => {
    hostMocks.bridge.kind = 'electron';
    hostMocks.invoke.mockReset();
    hostMocks.pickSave.mockReset();
    hostMocks.invoke.mockResolvedValue(sampleBundle('/tmp/YAQMC-diagnostics.zip'));
    hostMocks.pickSave.mockResolvedValue(null);
  });

  afterEach(() => {
    hostMocks.bridge.kind = 'electron';
    hostMocks.invoke.mockReset();
    hostMocks.pickSave.mockReset();
  });

  it('writes to destPath via _to without opening pickSave', async () => {
    const bundle = sampleBundle('D:\\exports\\given.zip');
    hostMocks.invoke.mockResolvedValue(bundle);
    await expect(
      exportDiagnosticsBundle({ includeLogs: false }, 'D:\\exports\\given.zip'),
    ).resolves.toEqual(bundle);
    expect(hostMocks.pickSave).not.toHaveBeenCalled();
    expect(hostMocks.invoke).toHaveBeenCalledWith('diagnostics_export_bundle_to', {
      path: 'D:\\exports\\given.zip',
      request: {
        includeLogs: false,
        overrideUnresolved: false,
        description: undefined,
        issueCategory: undefined,
      },
    });
  });

  it('picks a save path then calls _to', async () => {
    const dest = 'D:\\exports\\YAQMC-diagnostics.zip';
    const bundle = sampleBundle(dest);
    hostMocks.pickSave.mockResolvedValue(dest);
    hostMocks.invoke.mockResolvedValue(bundle);

    await expect(exportDiagnosticsBundle({ includeLogs: true })).resolves.toEqual(bundle);
    expect(hostMocks.pickSave).toHaveBeenCalledWith({ defaultPath: DIAGNOSTICS_ZIP_DEFAULT_NAME });
    expect(DIAGNOSTICS_ZIP_DEFAULT_NAME).toBe('YAQMC-diagnostics.zip');
    expect(hostMocks.invoke).toHaveBeenCalledWith('diagnostics_export_bundle_to', {
      path: dest,
      request: {
        includeLogs: true,
        overrideUnresolved: false,
        description: undefined,
        issueCategory: undefined,
      },
    });
  });

  it('surfaces a real error when pickSave returns a non-string path', async () => {
    hostMocks.pickSave.mockResolvedValue({ filePath: 'D:\\exports\\YAQMC-diagnostics.zip' });

    await expect(exportDiagnosticsBundle({ includeLogs: true })).rejects.toThrow(
      'Diagnostics save dialog returned an invalid path',
    );
    expect(hostMocks.invoke).not.toHaveBeenCalled();
  });

  it('throws DiagnosticsExportAbortedError when pickSave is cancelled', async () => {
    hostMocks.pickSave.mockResolvedValue(null);

    await expect(exportDiagnosticsBundle({ includeLogs: true })).rejects.toBeInstanceOf(
      DiagnosticsExportAbortedError,
    );
    expect(hostMocks.invoke).not.toHaveBeenCalled();
  });
});

describe('console forward preference', () => {
  afterEach(() => {
    loggerTesting.reset();
  });

  it('reads logging.consoleForward and defaults unknown values to error', async () => {
    hostMocks.invoke.mockResolvedValueOnce('warn');
    await expect(currentConsoleForwardMode()).resolves.toBe('warn');
    expect(hostMocks.invoke).toHaveBeenCalledWith('app_settings_get', {
      key: CONSOLE_FORWARD_SETTING_KEY,
    });

    hostMocks.invoke.mockResolvedValueOnce('nope');
    await expect(currentConsoleForwardMode()).resolves.toBe('error');
  });

  it('writes the preference and applies it live', async () => {
    hostMocks.invoke.mockResolvedValueOnce(undefined);
    await expect(setConsoleForwardPreference('off')).resolves.toBe('off');
    expect(hostMocks.invoke).toHaveBeenCalledWith('app_settings_set', {
      key: CONSOLE_FORWARD_SETTING_KEY,
      value: 'off',
    });
    expect(loggerTesting.consoleForwardMode()).toBe('off');
  });
});
