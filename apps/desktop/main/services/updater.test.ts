import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import {
  allowPrereleaseForChannel,
  canInstallInPlace,
  CHANNEL_HOST_UPDATE,
  CHECK_DELAY_MS,
  createUpdater,
  DEFAULT_RELEASE_URL,
  electronUpdaterFlags,
  linuxPackageFromEnv,
  type UpdatePayload,
  type UpdaterCheckResult,
  type UpdaterOptions,
  type UpdaterPort,
} from './updater';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const updaterSourcePath = path.join(desktopRoot, 'main/services/updater.ts');
const mainIndex = path.join(desktopRoot, 'main/index.ts');

function fakePort(overrides: Partial<UpdaterPort> = {}): UpdaterPort {
  return {
    checkForUpdates: async () => ({ outcome: 'not-available' }),
    downloadUpdate: async () => undefined,
    installUpdate: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createTestUpdater(
  overrides: Partial<UpdaterOptions> = {},
): {
  updater: ReturnType<typeof createUpdater>;
  emitted: Array<{ channel: typeof CHANNEL_HOST_UPDATE; payload: UpdatePayload }>;
  scheduleCheck: ReturnType<typeof vi.fn>;
  port: UpdaterPort;
} {
  const emitted: Array<{ channel: typeof CHANNEL_HOST_UPDATE; payload: UpdatePayload }> = [];
  const scheduleCheck = vi.fn();
  const port = overrides.port ?? fakePort();
  const updater = createUpdater({
    port,
    emit: (channel, payload) => {
      emitted.push({ channel, payload });
    },
    channel: 'latest',
    platform: 'win32',
    scheduleCheck,
    ...overrides,
  });
  return { updater, emitted, scheduleCheck, port };
}

describe('channel and flags', () => {
  it('binds allowPrerelease to nightly vs latest', () => {
    expect(allowPrereleaseForChannel('latest')).toBe(false);
    expect(allowPrereleaseForChannel('nightly')).toBe(true);
    expect(allowPrereleaseForChannel('development')).toBe(false);
    expect(electronUpdaterFlags('latest')).toEqual({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      verifyUpdateCodeSignature: false,
    });
    expect(electronUpdaterFlags('nightly').allowPrerelease).toBe(true);
  });

  it('defers launch check by 30 s without starting a real timer', () => {
    expect(CHECK_DELAY_MS).toBe(30_000);
    const { updater, scheduleCheck, emitted } = createTestUpdater();
    updater.scheduleLaunchCheck();
    expect(scheduleCheck).toHaveBeenCalledTimes(1);
    expect(scheduleCheck.mock.calls[0]?.[1]).toBe(CHECK_DELAY_MS);
    expect(emitted).toEqual([]);
    expect(updater.state()).toBe('idle');
  });

  it('does not schedule when no scheduler is injected', () => {
    const { updater } = createTestUpdater({ scheduleCheck: undefined });
    expect(() => updater.scheduleLaunchCheck()).not.toThrow();
    expect(updater.state()).toBe('idle');
  });
});

describe('install policy', () => {
  it('allows Windows NSIS and Linux AppImage only', () => {
    expect(canInstallInPlace({ platform: 'win32' })).toBe(true);
    expect(canInstallInPlace({ platform: 'linux', linuxPackage: 'AppImage' })).toBe(true);
    expect(canInstallInPlace({ platform: 'linux', linuxPackage: 'deb' })).toBe(false);
    expect(canInstallInPlace({ platform: 'linux', linuxPackage: 'rpm' })).toBe(false);
    expect(canInstallInPlace({ platform: 'linux', linuxPackage: 'tar.gz' })).toBe(false);
    expect(canInstallInPlace({ platform: 'linux' })).toBe(false);
    expect(linuxPackageFromEnv({ APPIMAGE: '/opt/YAQMC.AppImage' })).toBe('AppImage');
    expect(linuxPackageFromEnv({})).toBeUndefined();
  });
});

describe('notify state machine', () => {
  it('goes idle → checking → available and does not auto-download', async () => {
    const port = fakePort({
      checkForUpdates: async () =>
        ({ outcome: 'available', version: '1.2.3', releaseUrl: DEFAULT_RELEASE_URL }) satisfies UpdaterCheckResult,
    });
    const { updater, emitted } = createTestUpdater({ port });
    expect(updater.state()).toBe('idle');
    const result = await updater.check();
    expect(result.state).toBe('available');
    expect(result.version).toBe('1.2.3');
    expect(result.canInstall).toBe(true);
    expect(result.allowPrerelease).toBe(false);
    expect(emitted.map((entry) => entry.channel)).toEqual([CHANNEL_HOST_UPDATE, CHANNEL_HOST_UPDATE]);
    expect(emitted.map((entry) => entry.payload.state)).toEqual(['checking', 'available']);
    expect(port.installUpdate).not.toHaveBeenCalled();
  });

  it('goes checking → not-available', async () => {
    const { updater, emitted } = createTestUpdater();
    await updater.check();
    expect(updater.state()).toBe('not-available');
    expect(emitted.map((entry) => entry.payload.state)).toEqual(['checking', 'not-available']);
  });

  it('goes checking → error from port outcome or throw', async () => {
    const { updater } = createTestUpdater({
      port: fakePort({
        checkForUpdates: async () => ({ outcome: 'error', message: 'feed 404' }),
      }),
    });
    const payload = await updater.check();
    expect(payload.state).toBe('error');
    expect(payload.error).toBe('feed 404');

    const throwing = createTestUpdater({
      port: fakePort({
        checkForUpdates: async () => {
          throw new Error('offline');
        },
      }),
    });
    await throwing.updater.check();
    expect(throwing.updater.state()).toBe('error');
    expect(throwing.updater.payload().error).toContain('offline');
  });

  it('downloads only from available, then waits at ready-to-install', async () => {
    const port = fakePort({
      checkForUpdates: async () => ({ outcome: 'available', version: '2.0.0' }),
      downloadUpdate: vi.fn(async () => undefined),
    });
    const { updater, emitted } = createTestUpdater({ port });
    await updater.check();
    const afterDownload = await updater.download();
    expect(afterDownload.state).toBe('ready-to-install');
    expect(afterDownload.version).toBe('2.0.0');
    expect(port.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(port.installUpdate).not.toHaveBeenCalled();
    expect(emitted.map((entry) => entry.payload.state)).toEqual([
      'checking',
      'available',
      'downloading',
      'ready-to-install',
    ]);
  });

  it('installs only from ready-to-install (no silent auto-install)', async () => {
    const port = fakePort({
      checkForUpdates: async () => ({ outcome: 'available', version: '2.0.0' }),
    });
    const { updater } = createTestUpdater({ port });
    await updater.install();
    expect(port.installUpdate).not.toHaveBeenCalled();
    await updater.check();
    await updater.install();
    expect(port.installUpdate).not.toHaveBeenCalled();
    await updater.download();
    expect(updater.state()).toBe('ready-to-install');
    expect(port.installUpdate).not.toHaveBeenCalled();
    await updater.install();
    expect(port.installUpdate).toHaveBeenCalledTimes(1);
    expect(updater.state()).toBe('ready-to-install');
  });

  it('notifies Linux deb/rpm/tar.gz without downloading', async () => {
    const port = fakePort({
      checkForUpdates: async () => ({ outcome: 'available', version: '3.0.0' }),
      downloadUpdate: vi.fn(async () => undefined),
    });
    for (const linuxPackage of ['deb', 'rpm', 'tar.gz'] as const) {
      const { updater } = createTestUpdater({ port, platform: 'linux', linuxPackage });
      const available = await updater.check();
      expect(available.state).toBe('available');
      expect(available.canInstall).toBe(false);
      expect(available.releaseUrl).toBe(DEFAULT_RELEASE_URL);
      await updater.download();
      expect(updater.state()).toBe('available');
      expect(port.downloadUpdate).not.toHaveBeenCalled();
      await updater.install();
      expect(port.installUpdate).not.toHaveBeenCalled();
    }
  });

  it('lets Linux AppImage follow the download path', async () => {
    const port = fakePort({
      checkForUpdates: async () => ({ outcome: 'available', version: '3.1.0' }),
      downloadUpdate: vi.fn(async () => undefined),
    });
    const { updater } = createTestUpdater({
      port,
      platform: 'linux',
      linuxPackage: 'AppImage',
    });
    await updater.check();
    await updater.download();
    expect(updater.state()).toBe('ready-to-install');
    expect(port.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('ignores a second check while checking or downloading', async () => {
    let releaseCheck: ((result: UpdaterCheckResult) => void) | undefined;
    const pendingCheck = new Promise<UpdaterCheckResult>((resolve) => {
      releaseCheck = resolve;
    });
    const port = fakePort({
      checkForUpdates: () => pendingCheck,
      downloadUpdate: () => new Promise(() => undefined),
    });
    const { updater, emitted } = createTestUpdater({ port });
    const first = updater.check();
    expect(updater.state()).toBe('checking');
    await updater.check();
    expect(emitted).toHaveLength(1);
    releaseCheck?.({ outcome: 'available', version: '9.0.0' });
    await first;
    expect(updater.state()).toBe('available');

    const download = updater.download();
    expect(updater.state()).toBe('downloading');
    await updater.check();
    expect(updater.state()).toBe('downloading');
    void download;
  });

  it('records a download failure as error', async () => {
    const { updater } = createTestUpdater({
      port: fakePort({
        checkForUpdates: async () => ({ outcome: 'available', version: '1.0.1' }),
        downloadUpdate: async () => {
          throw new Error('disk full');
        },
      }),
    });
    await updater.check();
    await updater.download();
    expect(updater.state()).toBe('error');
    expect(updater.payload().error).toContain('disk full');
  });

  it('runs the deferred launch check through the injected scheduler', async () => {
    const { updater, scheduleCheck, emitted } = createTestUpdater();
    updater.scheduleLaunchCheck();
    const scheduled = scheduleCheck.mock.calls[0]?.[0] as (() => void) | undefined;
    expect(scheduled).toEqual(expect.any(Function));
    scheduled?.();
    await vi.waitFor(() => {
      expect(updater.state()).toBe('not-available');
    });
    expect(emitted.map((entry) => entry.payload.state)).toEqual(['checking', 'not-available']);
  });
});

describe('wired status', () => {
  it('is imported from main/index.ts without silent install', () => {
    const source = readFileSync(mainIndex, 'utf8');
    expect(source).toContain("from './services/updater'");
    expect(source).toContain('createUpdater');
    expect(source).toContain('createElectronUpdaterPort');
    expect(source).toContain('scheduleLaunchCheck');
    expect(source).not.toContain('quitAndInstall');
  });

  it('does not import electron-updater in the state machine and documents unsigned Windows (R-9)', () => {
    const source = readFileSync(updaterSourcePath, 'utf8');
    expect(source).not.toMatch(/from ['"]electron-updater['"]/);
    expect(source).not.toMatch(/require\(['"]electron-updater['"]\)/);
    expect(source).toContain('verifyUpdateCodeSignature: false');
    expect(source).toContain('R-9');
  });
});

describe('protocol cap', () => {
  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
