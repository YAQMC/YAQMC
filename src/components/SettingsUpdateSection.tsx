import { CHANNEL_HOST_UPDATE, type UpdatePayload, type UpdateState } from '@yaqmc/client';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getYaqmcClient } from '../application/yaqmc-runtime';

/** Host-only method Main will register in UPD-01. Not in METHOD_NAMES yet. */
export const HOST_UPDATER_CHECK_METHOD = 'host_updater_check';

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

export function updateStatusCopy(payload: UpdatePayload): string {
  switch (payload.state) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return payload.version ? `Version ${payload.version} is available.` : 'An update is available.';
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

export function SettingsUpdateSection() {
  const [payload, setPayload] = useState<UpdatePayload>(IDLE_UPDATE_PAYLOAD);

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

  const busy = isUpdateCheckBusy(payload.state);

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
      </div>
    </section>
  );
}
