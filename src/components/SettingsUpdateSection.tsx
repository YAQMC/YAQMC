import { CHANNEL_HOST_UPDATE, type UpdatePayload, type UpdateState } from '@yaqmc/client';
import { Download, ExternalLink, RefreshCw, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
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
  const t = i18n.getFixedT(null, 'settings', 'updates');
  switch (payload.state) {
    case 'checking':
      return t('checking');
    case 'available':
      if (!payload.canInstall) {
        return payload.version
          ? t('availableManualVersion', { version: payload.version })
          : t('availableManual');
      }
      return payload.version ? t('availableVersion', { version: payload.version }) : t('available');
    case 'not-available':
      return t('latest');
    case 'downloading':
      return t('downloading');
    case 'ready-to-install':
      return t('ready');
    case 'error':
      return payload.error === NOT_WIRED_ERROR
        ? t('notWired')
        : payload.error === 'update-download-failed'
          ? t('downloadFailed')
          : payload.error === 'update-install-failed'
            ? t('installFailed')
            : (payload.error ?? t('checkFailed'));
    default:
      return t('idle');
  }
}

export function SettingsUpdateSection({ mode = 'install' }: { mode?: 'install' | 'notify' }) {
  const { t } = useTranslation('settings', { keyPrefix: 'updates' });
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
        error: 'update-download-failed',
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
        error: 'update-install-failed',
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
          <h2>{t('title')}</h2>
          <p>{t('description')}</p>
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-row">
          <div>
            <strong>{t('check')}</strong>
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
            <RefreshCw size={14} /> {t('check')}
          </button>
        </div>
        {showDownload ? (
          <div className="settings-row">
            <div>
              <strong>{t('download')}</strong>
              <span>{t('downloadDescription')}</span>
            </div>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void download()}
            >
              <Download size={14} /> {t('downloadAction')}
            </button>
          </div>
        ) : null}
        {showReleaseLink ? (
          <div className="settings-row">
            <div>
              <strong>{t('release')}</strong>
              <span>{notifyOnly ? t('androidReleaseDescription') : t('releaseDescription')}</span>
              {payload.releaseNotes ? (
                <p className="settings-update-notes">{payload.releaseNotes}</p>
              ) : null}
            </div>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void openRelease()}
            >
              <ExternalLink size={14} /> {t('releaseAction')}
            </button>
          </div>
        ) : null}
        {showInstall ? (
          <div className="settings-row">
            <div>
              <strong>{t('install')}</strong>
              <span>{t('installDescription')}</span>
            </div>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void install()}
            >
              <RotateCw size={14} /> {t('install')}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
