/**
 * UPD-01 notify-flow state machine for `host://update`.
 *
 * Wired from `main/index.ts` with `createElectronUpdaterPort` (or a no-op
 * port during `YAQMC_DESKTOP_SMOKE`). This module stays free of
 * `electron-updater` so unit tests inject a fake port.
 *
 * AutoUpdater flags (do not silent-install):
 *
 * - `autoDownload: false`
 * - `autoInstallOnAppQuit: false`
 * - `allowPrerelease` bound to `__YAQMC_RELEASE_CHANNEL__` (`nightly` → true)
 * - Windows unsigned (R-9): `verifyUpdateCodeSignature: false`
 * - Linux: AppImage can in-place install; deb / rpm / tar.gz only notify
 *
 * Launch check is deferred `CHECK_DELAY_MS` (30 s). Callers inject
 * `scheduleCheck`; this file does not start a timer by default.
 */

import { CHANNEL_HOST_UPDATE, type UpdatePayload, type UpdateState } from '@yaqmc/client';

export { CHANNEL_HOST_UPDATE };
export type { UpdatePayload, UpdateState };

export const CHECK_DELAY_MS = 30_000;
export const DEFAULT_RELEASE_URL = 'https://github.com/YAQMC/YAQMC/releases';

export type LinuxPackageKind = 'AppImage' | 'deb' | 'rpm' | 'tar.gz';

export type UpdaterCheckResult =
  | { outcome: 'available'; version: string; releaseUrl?: string }
  | { outcome: 'not-available' }
  | { outcome: 'error'; message: string };

/**
 * Seam for the real `electron-updater` AutoUpdater (UPD-01). Tests inject a
 * fake. `installUpdate` is user-initiated only — the state machine never
 * calls it after a download.
 */
export type UpdaterPort = {
  checkForUpdates(): Promise<UpdaterCheckResult>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void> | void;
};

export type ScheduleCheck = (callback: () => void, delayMs: number) => unknown;

export type UpdateEmit = (channel: typeof CHANNEL_HOST_UPDATE, payload: UpdatePayload) => void;

export type UpdaterOptions = {
  port: UpdaterPort;
  emit: UpdateEmit;
  channel: string;
  platform?: NodeJS.Platform | string;
  linuxPackage?: LinuxPackageKind;
  env?: NodeJS.ProcessEnv;
  scheduleCheck?: ScheduleCheck;
};

export type ElectronUpdaterFlags = {
  autoDownload: false;
  autoInstallOnAppQuit: false;
  allowPrerelease: boolean;
  /** Windows unsigned (R-9). See file header. */
  verifyUpdateCodeSignature: false;
};

export function allowPrereleaseForChannel(channel: string): boolean {
  return channel === 'nightly';
}

/**
 * Flags UPD-01 will apply on `electron-updater`. `verifyUpdateCodeSignature: false`
 * is required for unsigned Windows NSIS (R-9).
 */
export function electronUpdaterFlags(channel: string): ElectronUpdaterFlags {
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: allowPrereleaseForChannel(channel),
    verifyUpdateCodeSignature: false,
  };
}

export function linuxPackageFromEnv(env: NodeJS.ProcessEnv): LinuxPackageKind | undefined {
  if (typeof env.APPIMAGE === 'string' && env.APPIMAGE.length > 0) {
    return 'AppImage';
  }
  return undefined;
}

export function canInstallInPlace(options: {
  platform: NodeJS.Platform | string;
  linuxPackage?: LinuxPackageKind;
}): boolean {
  if (options.platform === 'linux') {
    return options.linuxPackage === 'AppImage';
  }
  return options.platform === 'win32';
}

export type UpdaterHandle = {
  state(): UpdateState;
  payload(): UpdatePayload;
  scheduleLaunchCheck(): void;
  check(): Promise<UpdatePayload>;
  download(): Promise<UpdatePayload>;
  install(): Promise<UpdatePayload>;
};

export function createUpdater(options: UpdaterOptions): UpdaterHandle {
  const platform =
    options.platform ?? (typeof process !== 'undefined' ? process.platform : 'win32');
  const linuxPackage = options.linuxPackage ?? linuxPackageFromEnv(options.env ?? {});
  const canInstall = canInstallInPlace({ platform, linuxPackage });
  const allowPrerelease = allowPrereleaseForChannel(options.channel);

  let state: UpdateState = 'idle';
  let version: string | undefined;
  let releaseUrl: string | undefined;
  let error: string | undefined;

  const payload = (): UpdatePayload => {
    const next: UpdatePayload = {
      state,
      canInstall,
      allowPrerelease,
      channel: options.channel,
    };
    if (version !== undefined) {
      next.version = version;
    }
    if (releaseUrl !== undefined) {
      next.releaseUrl = releaseUrl;
    }
    if (error !== undefined) {
      next.error = error;
    }
    return next;
  };

  const emit = (next: UpdateState): UpdatePayload => {
    state = next;
    const body = payload();
    options.emit(CHANNEL_HOST_UPDATE, body);
    return body;
  };

  const check = async (): Promise<UpdatePayload> => {
    if (state === 'checking' || state === 'downloading') {
      return payload();
    }
    emit('checking');
    try {
      const result = await options.port.checkForUpdates();
      if (result.outcome === 'available') {
        version = result.version;
        releaseUrl = result.releaseUrl ?? DEFAULT_RELEASE_URL;
        error = undefined;
        return emit('available');
      }
      if (result.outcome === 'not-available') {
        version = undefined;
        releaseUrl = undefined;
        error = undefined;
        return emit('not-available');
      }
      version = undefined;
      releaseUrl = undefined;
      error = result.message;
      return emit('error');
    } catch (caught: unknown) {
      version = undefined;
      releaseUrl = undefined;
      error = String(caught);
      return emit('error');
    }
  };

  return {
    state: () => state,
    payload,
    scheduleLaunchCheck(): void {
      options.scheduleCheck?.(() => {
        void check();
      }, CHECK_DELAY_MS);
    },
    check,
    async download(): Promise<UpdatePayload> {
      if (state !== 'available' || !canInstall) {
        return payload();
      }
      emit('downloading');
      try {
        await options.port.downloadUpdate();
        error = undefined;
        return emit('ready-to-install');
      } catch (caught: unknown) {
        error = String(caught);
        return emit('error');
      }
    },
    async install(): Promise<UpdatePayload> {
      if (state !== 'ready-to-install' || !canInstall) {
        return payload();
      }
      try {
        await options.port.installUpdate();
      } catch (caught: unknown) {
        error = String(caught);
        return emit('error');
      }
      return payload();
    },
  };
}
