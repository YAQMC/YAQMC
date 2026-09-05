import { CHANNEL_HOST_UPDATE, type UpdatePayload, type UpdateState } from '@yaqmc/client';
import { Download, ExternalLink, RefreshCw, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getYaqmcClient } from '../application/yaqmc-runtime';

/** Host-only methods Main registers in UPD-01. Not in METHOD_NAMES. */
export const HOST_UPDATER_CHECK_METHOD = 'host_updater_check';
export const HOST_UPDATER_DOWNLOAD_METHOD = 'host_updater_download';
export const HOST_UPDATER_INSTALL_METHOD = 'host_updater_install';

export const NOT_WIRED_ERROR = 'Updater check is not wired yet';

export const IDLE_UPDATE_PAYLOAD: UpdatePayload = {
  state: 'idle',
  canInstall: false,
  allowPrerelease: false,
  channel: 'latest',
};

type HostInvokeSeam = {
  invoke: (method: string) => Promise<unknown>;
};

export function isUpdateCheckBusy(state: UpdateState): boolean {
  return state === 'checking' || state === 'downloading';
}

export function notWiredUpdatePayload(): UpdatePayload {
  return {
    ...IDLE_UPDATE_PAYLOAD,
    state: 'error',
    error: NOT_WIRED_ERROR,
  };
}

export async function requestHostUpdateCheck(client: HostInvokeSeam): Promise<void> {
  await client.invoke(HOST_UPDATER_CHECK_METHOD);
}

export async function requestHostUpdateDownload(client: HostInvokeSeam): Promise<void> {
  await client.invoke(HOST_UPDATER_DOWNLOAD_METHOD);
}

export async function requestHostUpdateInstall(client: HostInvokeSeam): Promise<void> {
  await client.invoke(HOST_UPDATER_INSTALL_METHOD);
}

export function updateStatusCopy(payload: UpdatePayload): string {
  switch (payload.state) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      if (!payload.canInstall) {
        return payload.version
          ? `Version ${payload.version} is available. This package cannot update in place — open the release page.`
          : 'An update is available. This package cannot update in place — open the release page.';
      }
      return payload.version
        ? `Version ${payload.version} is available.`
        : 'An update is available.';
    case 'not-available':
      return 'You are on the latest version.';
    case 'downloading':
      return 'Downloading update…';
    case 'ready-to-install':
      return 'Update downloaded. Restart YAQMC to install.';
    case 'error':
      return payload.error === NOT_WIRED_ERROR
        ? 'Update checks are not wired in this build.'
        : (payload.error ?? 'Could not check for updates.');
    default:
      return 'No update check has run yet.';
  }
}

export function SettingsUpdateSection({ mode = 'install' }: { mode?: 'install' | 'notify' }) {
  const [payload, setPayload] = useState<UpdatePayload>(IDLE_UPDATE_PAYLOAD);
  const notifyOnly = mode === 'notify';

  useEffect(() => {
    return getYaqmcClient().on(CHANNEL_HOST_UPDATE, (next) => {
      setPayload(next);
    });
  }, []);

  const check = async () => {
    if (isUpdateCheckBusy(payload.state)) return;
    setPayload((current) => ({ ...current, state: 'checking', error: undefined }));
    try {
      await requestHostUpdateCheck(getYaqmcClient() as unknown as HostInvokeSeam);
    } catch {
      setPayload(notWiredUpdatePayload());
    }
  };

  const download = async () => {
    if (payload.state !== 'available' || !payload.canInstall) return;
    try {
      await requestHostUpdateDownload(getYaqmcClient() as unknown as HostInvokeSeam);
    } catch {
      setPayload((current) => ({
        ...current,
        state: 'error',
        error: 'Could not download the update.',
      }));
    }
  };

  const install = async () => {
    if (payload.state !== 'ready-to-install' || !payload.canInstall) return;
    try {
      await requestHostUpdateInstall(getYaqmcClient() as unknown as HostInvokeSeam);
    } catch {
      setPayload((current) => ({
        ...current,
        state: 'error',
        error: 'Could not restart to install.',
      }));
    }
  };

  const openRelease = async () => {
    const url = payload.releaseUrl;
    if (!url) return;
    await getYaqmcClient().host.shell.openExternal(url);
  };

  const busy = isUpdateCheckBusy(payload.state);
  const showDownload = payload.state === 'available' && payload.canInstall;
  const showReleaseLink = payload.state === 'available' && Boolean(payload.releaseUrl);
  const showInstall = payload.state === 'ready-to-install' && payload.canInstall;

  return (
    <section className="settings-section">
      <div className="settings-section__heading">
        <div>
          <h2>Updates</h2>
          <p>Check for a new YAQMC release. Updates are never installed silently.</p>
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-row">
          <div>
            <strong>Check for updates</strong>
            <span
              data-update-state={payload.state}
              role={payload.state === 'error' ? 'alert' : 'status'}
            >
              {updateStatusCopy(payload)}
            </span>
          </div>
          <button
            type="button"
            className="button button--secondary"
            disabled={busy}
            onClick={() => void check()}
          >
            <RefreshCw size={14} /> Check for updates
          </button>
        </div>
        {showDownload ? (
          <div className="settings-row">
            <div>
              <strong>Download</strong>
              <span>Starts only after you click. Nothing installs in the background.</span>
            </div>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void download()}
            >
              <Download size={14} /> Download update
            </button>
          </div>
        ) : null}
        {showReleaseLink ? (
          <div className="settings-row">
            <div>
              <strong>Release page</strong>
              <span>
                {notifyOnly
                  ? 'Android opens the signed APK on GitHub Releases and never installs it automatically.'
                  : 'deb / rpm / tar.gz builds cannot update in place.'}
              </span>
              {payload.releaseNotes ? (
                <p className="settings-update-notes">{payload.releaseNotes}</p>
              ) : null}
            </div>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void openRelease()}
            >
              <ExternalLink size={14} /> Open release page
            </button>
          </div>
        ) : null}
        {showInstall ? (
          <div className="settings-row">
            <div>
              <strong>Restart to install</strong>
              <span>Installs only after you click. Playback will stop.</span>
            </div>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void install()}
            >
              <RotateCw size={14} /> Restart to install
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
