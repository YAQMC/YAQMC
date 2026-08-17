import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import {
  attachHostPayloadToExportParams,
  collectDiagnosticsHostPayload,
  diagnosticsDisplayBackend,
  diagnosticsDisplayCapabilities,
  HOST_LOG_TAIL_MAX_BYTES,
  HOST_PAYLOAD_SCHEMA_VERSION,
} from './diagnostics-host-payload';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'diagnostics-host-payload.ts'),
  'utf8',
);

const desktopPackage = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
) as { devDependencies?: { electron?: string } };

describe('collectDiagnosticsHostPayload', () => {
  it('builds host.json fields from injected versions, windows, display, updater, and restart counter', () => {
    const payload = collectDiagnosticsHostPayload({
      versions: { electron: '43.4.0', chrome: '140.0.7339.241', node: '24.11.1' },
      windows: [
        {
          id: 1,
          role: 'main',
          visible: true,
          focused: true,
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
        },
        { id: 2, role: 'lyrics-desktop', visible: false, alwaysOnTop: true },
      ],
      display: {
        backend: 'win32',
        capabilities: {
          alwaysOnTop: true,
          clickThrough: true,
          globalShortcuts: true,
          transparency: true,
        },
      },
      updater: { state: 'idle', canInstall: true, allowPrerelease: false, channel: 'stable' },
      restartCounter: 2,
      linuxGraphics: {
        platform: 'linux',
        mode: 'gpu-off',
        canonicalMode: 'gpu-off',
        switches: ['--disable-gpu'],
        deprecatedEnv: true,
      },
    });
    expect(payload).toEqual({
      schemaVersion: HOST_PAYLOAD_SCHEMA_VERSION,
      electron: '43.4.0',
      chrome: '140.0.7339.241',
      node: '24.11.1',
      windows: [
        {
          id: 1,
          role: 'main',
          visible: true,
          focused: true,
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
        },
        { id: 2, role: 'lyrics-desktop', visible: false, alwaysOnTop: true },
      ],
      display: {
        backend: 'win32',
        capabilities: {
          alwaysOnTop: true,
          clickThrough: true,
          globalShortcuts: true,
          transparency: true,
        },
      },
      updater: { state: 'idle', canInstall: true, allowPrerelease: false, channel: 'stable' },
      restartCounter: 2,
      linuxGraphics: {
        platform: 'linux',
        mode: 'gpu-off',
        canonicalMode: 'gpu-off',
        switches: ['--disable-gpu'],
        deprecatedEnv: true,
      },
    });
    expect(payload.log).toBeUndefined();
  });

  it('includes an optional host.log tail and truncates to the 64 KiB ring', () => {
    const payload = collectDiagnosticsHostPayload({
      versions: { electron: '43.4.0', chrome: '140.0.0.0', node: '24.0.0' },
      windows: [],
      display: {
        backend: 'wayland',
        capabilities: {
          alwaysOnTop: false,
          clickThrough: false,
          globalShortcuts: true,
          transparency: true,
        },
      },
      updater: { state: 'error', error: 'network' },
      restartCounter: 0,
      log: 'stderr from core\n',
    });
    expect(payload.log).toBe('stderr from core\n');
    expect(payload.display.backend).toBe('wayland');

    const oversized = `aa${'x'.repeat(HOST_LOG_TAIL_MAX_BYTES)}`;
    const truncated = collectDiagnosticsHostPayload({
      versions: {},
      windows: [],
      display: {
        backend: 'x11',
        capabilities: {
          alwaysOnTop: true,
          clickThrough: false,
          globalShortcuts: false,
          transparency: false,
        },
      },
      updater: { state: 'checking' },
      restartCounter: 1,
      log: oversized,
    });
    expect(Buffer.byteLength(truncated.log ?? '', 'utf8')).toBe(HOST_LOG_TAIL_MAX_BYTES);
    expect(truncated.log?.endsWith('x')).toBe(true);
    expect(truncated.electron).toBe('');
    expect(truncated.chrome).toBe('');
    expect(truncated.node).toBe('');
  });

  it('is a pure collector: no Electron import and no process.env reads', () => {
    expect(source).not.toMatch(/from ['"]electron['"]/);
    expect(source).not.toMatch(/\bprocess\.env\b/);
  });

  it('injects hostPayload into export-bundle params and overwrites a renderer blob', () => {
    const hostPayload = collectDiagnosticsHostPayload({
      versions: { electron: '43.4.0' },
      windows: [],
      display: {
        backend: 'x11',
        capabilities: diagnosticsDisplayCapabilities(false),
      },
      updater: { state: 'idle' },
      restartCounter: 0,
    });
    expect(attachHostPayloadToExportParams({ request: { includeLogs: true } }, hostPayload)).toEqual({
      request: { includeLogs: true, hostPayload },
    });
    expect(
      attachHostPayloadToExportParams(
        { path: 'D:\\out\\YAQMC-diagnostics.zip', request: { hostPayload: { schemaVersion: 0 } } },
        hostPayload,
      ),
    ).toEqual({
      path: 'D:\\out\\YAQMC-diagnostics.zip',
      request: { hostPayload },
    });
    expect(diagnosticsDisplayBackend({ platform: 'linux', nativeWayland: true })).toBe('wayland');
    expect(diagnosticsDisplayBackend({ platform: 'win32', nativeWayland: false })).toBe('win32');
    expect(diagnosticsDisplayCapabilities(true)).toEqual({
      alwaysOnTop: false,
      clickThrough: false,
      globalShortcuts: false,
      transparency: true,
    });
  });
});

describe('pins', () => {
  it('leaves Electron 43.4.0 and the 32 MiB protocol cap unchanged', () => {
    expect(desktopPackage.devDependencies?.electron).toBe('43.4.0');
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
