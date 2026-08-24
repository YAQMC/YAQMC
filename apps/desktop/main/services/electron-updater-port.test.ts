import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import { applyElectronUpdaterFlags, noopUpdaterPort } from './electron-updater-port';
import { electronUpdaterFlags } from './updater';

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'electron-updater-port.ts'),
  'utf8',
);

describe('electron-updater port', () => {
  it('keeps notify-only flags without disabling the default signature verifier', () => {
    const signatureVerifier = vi.fn();
    const autoUpdater = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowPrerelease: true,
      verifyUpdateCodeSignature: signatureVerifier,
    };
    applyElectronUpdaterFlags(autoUpdater, 'latest');
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    expect(autoUpdater.allowPrerelease).toBe(false);
    expect(autoUpdater.verifyUpdateCodeSignature).toBe(signatureVerifier);
    expect(electronUpdaterFlags('nightly').allowPrerelease).toBe(true);
  });

  it('loads electron-updater via createRequire and never silent-installs from check/download', () => {
    expect(source).toContain('createRequire(import.meta.url)');
    expect(source).toContain("require('electron-updater')");
    expect(source).toContain('quitAndInstall(false, true)');
    expect(source).not.toContain('quitAndInstall(true');
    expect(source).toContain('installUpdate(): void');
    expect(source).toContain('noopUpdaterPort');
  });

  it('smoke/no-op port reports not-available without downloading', async () => {
    const port = noopUpdaterPort();
    await expect(port.checkForUpdates()).resolves.toEqual({ outcome: 'not-available' });
    await expect(port.downloadUpdate()).resolves.toBeUndefined();
    expect(port.installUpdate()).toBeUndefined();
  });
});

describe('pins', () => {
  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
