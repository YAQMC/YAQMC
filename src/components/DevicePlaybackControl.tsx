import { MonitorSmartphone } from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DevicePlaybackPreview,
  DevicePlaybackResult,
  DevicePlaybackSharingStatus,
} from '@yaqmc/client';
import { ProviderContext } from '../application/provider-context';
import { useAccountStore } from '../application/account-runtime';
import { isNativeRuntime } from '../application/native-player-runtime';
import { getYaqmcClient } from '../application/yaqmc-runtime';
import { IconButton } from './ui/IconButton';
import { PluginDialog } from './PluginDialog';
import { ANDROID_MODAL_BACK_EVENT } from '../application/android-back-navigation';

export function DevicePlaybackControl() {
  const provider = useContext(ProviderContext);
  const snapshot = useAccountStore((state) => state.snapshot);
  const { t } = useTranslation('player', { keyPrefix: 'devicePlayback' });
  if (!isNativeRuntime || provider?.id !== 'qqmusic') return null;
  const authenticated =
    snapshot.state === 'authenticated' &&
    snapshot.profileId === provider.profileId &&
    (snapshot.providerId ?? 'qqmusic') === provider.id;
  if (!authenticated)
    return (
      <IconButton label={t('loginRequired')} size="small" disabled>
        <MonitorSmartphone size={16} />
      </IconButton>
    );
  return (
    <DevicePlaybackSession
      key={`${provider.profileId}:${snapshot.profile?.maskedIdentity}`}
      profileId={provider.profileId}
    />
  );
}

function DevicePlaybackSession({ profileId }: { profileId: string }) {
  const { t, i18n } = useTranslation('player', { keyPrefix: 'devicePlayback' });
  const { t: common } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'taking' | 'done' | 'error'>(
    'idle',
  );
  const [preview, setPreview] = useState<DevicePlaybackPreview | null>(null);
  const [result, setResult] = useState<DevicePlaybackResult | null>(null);
  const [expired, setExpired] = useState(false);
  const request = useRef(0);
  const busy = useRef(false);
  const [sharing, setSharing] = useState<DevicePlaybackSharingStatus | null>(null);
  const [sharingPending, setSharingPending] = useState(false);
  const [sharingError, setSharingError] = useState(false);
  const sharingRequest = useRef(0);
  const sharingBusy = useRef(false);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    const read = async () => {
      if (sharingBusy.current) return;
      const id = ++sharingRequest.current;
      try {
        const value = await getYaqmcClient().invoke('provider_device_playback_sharing', {
          providerId: 'qqmusic',
          profileId,
        });
        if (disposed || id !== sharingRequest.current) return;
        setSharing(value);
        setSharingError(false);
      } catch {
        if (!disposed && id === sharingRequest.current) setSharingError(true);
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 3000);
    return () => {
      window.clearInterval(timer);
      disposed = true;
    };
  }, [open, profileId]);
  const configureSharing = async (enabled: boolean) => {
    if (sharingBusy.current) return;
    sharingBusy.current = true;
    setSharingPending(true);
    const id = ++sharingRequest.current;
    try {
      const value = await getYaqmcClient().invoke('provider_device_playback_sharing', {
        providerId: 'qqmusic',
        profileId,
        enabled,
      });
      if (id !== sharingRequest.current) return;
      setSharing(value);
      setSharingError(false);
    } catch {
      if (id === sharingRequest.current) setSharingError(true);
    } finally {
      sharingBusy.current = false;
      setSharingPending(false);
    }
  };
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener(ANDROID_MODAL_BACK_EVENT, close);
    return () => window.removeEventListener(ANDROID_MODAL_BACK_EVENT, close);
  }, [open]);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  useEffect(() => {
    if (!preview) return;
    const timer = window.setTimeout(() => setExpired(true), preview.expiresInMs);
    return () => window.clearTimeout(timer);
  }, [preview]);
  const load = async () => {
    if (busy.current) return;
    busy.current = true;
    const id = ++request.current;
    setPhase('loading');
    setResult(null);
    setPreview(null);
    setExpired(false);
    try {
      const value = await getYaqmcClient().invoke('provider_device_playback_preview', {
        providerId: 'qqmusic',
        profileId,
      });
      if (request.current !== id) return;
      setPreview(value);
      setPhase('ready');
    } catch {
      if (request.current === id) setPhase('error');
    } finally {
      if (request.current === id) busy.current = false;
    }
  };
  const takeOver = async () => {
    if (busy.current || !preview || expired) return;
    busy.current = true;
    const id = ++request.current;
    const token = preview.token;
    setPhase('taking');
    setPreview(null);
    try {
      const value = await getYaqmcClient().invoke('provider_device_playback_takeover', {
        providerId: 'qqmusic',
        profileId,
        token,
      });
      if (request.current !== id) return;
      setResult(value);
      setPhase('done');
    } catch {
      if (request.current === id) setPhase('error');
    } finally {
      if (request.current === id) busy.current = false;
    }
  };
  const current = preview?.tracks.find((track) => track.id === preview.currentSongId);
  return (
    <>
      <IconButton
        label={t('title')}
        size="small"
        onClick={() => {
          setOpen(true);
          if (phase === 'idle') void load();
        }}
      >
        <MonitorSmartphone size={16} />
      </IconButton>
      {open && (
        <PluginDialog
          label={t('title')}
          closeLabel={common('close')}
          onClose={() => setOpen(false)}
        >
          <div className="device-playback">
            <h2>{t('title')}</h2>
            <p>{t('notice')}</p>
            <label className="device-playback__sharing">
              <input
                type="checkbox"
                checked={sharing?.enabled ?? false}
                disabled={!sharing || sharingPending}
                onChange={(event) => void configureSharing(event.currentTarget.checked)}
              />
              {t('sharing')}
            </label>
            <p>{t('sharingHelp')}</p>
            {sharing && (
              <p>
                {t('platform', {
                  platform: sharing.platform === 'android' ? 'Android' : 'Desktop',
                })}
              </p>
            )}
            {sharing?.enabled && (
              <p role="status">
                {t(
                  sharing.lastErrorCode === 'preview-only'
                    ? 'previewOnly'
                    : `sharingStatus.${sharing.reportStatus}`,
                )}
              </p>
            )}
            {sharingError && <p role="alert">{t('sharingError')}</p>}
            <div aria-live="polite" role="status">
              {phase === 'loading' && <p>{t('loading')}</p>}
              {phase === 'taking' && <p>{t('taking')}</p>}
              {phase === 'ready' && !preview && <p>{t('empty')}</p>}
              {phase === 'error' && <p>{t('error')}</p>}
              {result && (
                <>
                  <p>{t(result.localStarted ? 'localStarted' : 'localNotStarted')}</p>
                  <p>
                    {t(
                      result.reportErrorCode === 'preview-only'
                        ? 'previewOnly'
                        : result.reportStatus === 'reported'
                          ? 'reported'
                          : result.reportStatus === 'not-sent'
                            ? 'notSent'
                            : 'unconfirmed',
                    )}
                  </p>
                  <p>{t('remoteUnconfirmed')}</p>
                </>
              )}
            </div>
            {preview && (
              <>
                <h3>{current?.title}</h3>
                <p>{current?.artists.map((artist) => artist.name).join(' / ')}</p>
                <p>
                  {t('updated', {
                    time: new Date(preview.updatedAtMs).toLocaleString(i18n.resolvedLanguage),
                  })}
                </p>
                <p>
                  {t('queue', { count: preview.tracks.length })}
                  {preview.queueTruncated ? ` · ${t('truncated')}` : ''}
                </p>
                <p>{t(expired ? 'expired' : 'confirm')}</p>
                <button
                  className="button button--primary"
                  disabled={expired || !current || current.availability.status === 'unavailable'}
                  onClick={() => void takeOver()}
                >
                  {t('takeOver')}
                </button>
              </>
            )}
            <button
              className="button button--quiet"
              disabled={phase === 'loading' || phase === 'taking'}
              onClick={() => void load()}
            >
              {t('refresh')}
            </button>
          </div>
        </PluginDialog>
      )}
    </>
  );
}
