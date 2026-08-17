import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import { createPreloadHostInfo, hostIsPackaged } from '../preload/packaged';

describe('hostIsPackaged', () => {
  it('treats the Electron executable as unpackaged', () => {
    expect(hostIsPackaged('C:\\Users\\dev\\electron.exe', 'win32')).toBe(false);
    expect(hostIsPackaged('/usr/bin/electron', 'linux')).toBe(false);
  });

  it('treats the packaged app executable as packaged', () => {
    expect(hostIsPackaged('C:\\Program Files\\YAQMC\\YAQMC.exe', 'win32')).toBe(true);
    expect(hostIsPackaged('/opt/YAQMC/yaqmc', 'linux')).toBe(true);
  });

  it('fails closed when execPath is missing', () => {
    expect(hostIsPackaged('', 'win32')).toBe(false);
    expect(hostIsPackaged('', 'linux')).toBe(false);
  });
});

describe('createPreloadHostInfo', () => {
  it('adds packaged without changing coreProtocol', () => {
    const info = createPreloadHostInfo('43.4.0', 'win32', 'D:\\YAQMC.exe');
    expect(info).toEqual({
      electron: '43.4.0',
      platform: 'win32',
      coreProtocol: 1,
      packaged: true,
    });
  });

  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});

describe('preload hostInfo wiring', () => {
  it('does not read process.env when advertising packaged', () => {
    const preloadDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../preload');
    for (const file of ['main.ts', 'lyrics-surface.ts', 'unlock-overlay.ts']) {
      const source = readFileSync(path.join(preloadDir, file), 'utf8');
      expect(source).toContain('createPreloadHostInfo');
      expect(source).not.toContain('process.env');
    }
  });
});
