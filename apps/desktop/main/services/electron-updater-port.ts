/**
 * UPD-01 adapter. Loads `electron-updater` via createRequire so the ESM
 * Main bundle can keep the package external (do not esbuild-bundle it).
 *
 * Notify-only: never sets autoDownload / autoInstallOnAppQuit, never calls
 * quitAndInstall from check or download. The default Windows publisher-signature
 * verifier remains installed; this adapter never replaces or disables it.
 */

import { createRequire } from 'node:module';
import {
  DEFAULT_RELEASE_URL,
  electronUpdaterFlags,
  type UpdaterCheckResult,
  type UpdaterPort,
} from './updater';

type ElectronUpdaterFlagsTarget = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
};

type AutoUpdaterLike = ElectronUpdaterFlagsTarget & {
  currentVersion?: { version: string };
  checkForUpdates(): Promise<{
    isUpdateAvailable?: boolean;
    updateInfo?: { version?: string };
  } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
};

function loadAutoUpdater(): AutoUpdaterLike {
  const require = createRequire(import.meta.url);
  const loaded = require('electron-updater') as { autoUpdater: AutoUpdaterLike };
  return loaded.autoUpdater;
}

export function applyElectronUpdaterFlags(
  autoUpdater: ElectronUpdaterFlagsTarget,
  channel: string,
): void {
  const flags = electronUpdaterFlags(channel);
  autoUpdater.autoDownload = flags.autoDownload;
  autoUpdater.autoInstallOnAppQuit = flags.autoInstallOnAppQuit;
  autoUpdater.allowPrerelease = flags.allowPrerelease;
}

export function createElectronUpdaterPort(channel: string): UpdaterPort {
  const autoUpdater = loadAutoUpdater();
  applyElectronUpdaterFlags(autoUpdater, channel);
  return {
    async checkForUpdates(): Promise<UpdaterCheckResult> {
      try {
        const result = await autoUpdater.checkForUpdates();
        const version = result?.updateInfo?.version;
        const available =
          result?.isUpdateAvailable === true ||
          (typeof version === 'string' &&
            version.length > 0 &&
            version !== autoUpdater.currentVersion?.version);
        if (!available || !version) {
          return { outcome: 'not-available' };
        }
        return {
          outcome: 'available',
          version,
          releaseUrl: DEFAULT_RELEASE_URL,
        };
      } catch (caught: unknown) {
        return { outcome: 'error', message: String(caught) };
      }
    },
    async downloadUpdate(): Promise<void> {
      await autoUpdater.downloadUpdate();
    },
    installUpdate(): void {
      // User-initiated only. isSilent=false — no silent install.
      autoUpdater.quitAndInstall(false, true);
    },
  };
}

export function noopUpdaterPort(): UpdaterPort {
  return {
    checkForUpdates: async () => ({ outcome: 'not-available' }),
    downloadUpdate: async () => undefined,
    installUpdate: () => undefined,
  };
}
