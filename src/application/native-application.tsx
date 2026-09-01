import {
  CHANNEL_HOST_CORE_STATUS,
  CHANNEL_PLUGIN_CHANGED,
  type ProviderDescriptor,
} from '@yaqmc/client';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import App from '../App';
import type { MusicProvider } from '../providers/music-provider';
import { createNativeMusicProvider } from '../providers/native/native-music-provider';
import { qqMusicProvider } from '../providers/qqmusic/qq-music-provider';
import { MusicProviderRoot } from './provider-root';
import { getYaqmcClient } from './yaqmc-runtime';

export function NativeApplication({ initialProviderId }: { initialProviderId?: string }) {
  const { t } = useTranslation('pages');
  const [descriptors, setDescriptors] = useState<ProviderDescriptor[] | null>(null);
  useEffect(() => {
    const client = getYaqmcClient();
    let generation = 0;
    const reload = () => {
      const requestGeneration = ++generation;
      void client
        .invoke('provider_list')
        .then((next) => {
          if (requestGeneration === generation) setDescriptors(next);
        })
        .catch(() => {
          if (requestGeneration === generation) setDescriptors([]);
        });
    };
    reload();
    const stopPluginChanged = client.on(CHANNEL_PLUGIN_CHANGED, reload);
    const stopCoreStatus = client.on(CHANNEL_HOST_CORE_STATUS, (payload) => {
      if (payload.status === 'ready') reload();
    });
    return () => {
      generation += 1;
      stopPluginChanged();
      stopCoreStatus();
    };
  }, []);
  const providers = useMemo<MusicProvider[]>(() => {
    const active = descriptors
      ?.filter((descriptor) => descriptor.available && descriptor.capabilities.catalog)
      .map(createNativeMusicProvider);
    return active && active.length > 0 ? active : [qqMusicProvider];
  }, [descriptors]);
  const providerOptions = useMemo(() => {
    const options = descriptors
      ?.filter((descriptor) => descriptor.capabilities.catalog)
      .map((descriptor) => ({
        id: descriptor.providerId,
        displayName: descriptor.displayName,
        available: descriptor.available,
        capabilities: descriptor.capabilities,
      }));
    return options && options.length > 0 ? options : undefined;
  }, [descriptors]);
  if (descriptors === null) {
    return (
      <main className="app-bootstrap" aria-label={t('loadingMusic')} aria-busy="true">
        <span className="app-bootstrap__mark" aria-hidden="true" />
        <span className="app-bootstrap__copy">
          <strong>YAQMC</strong>
          <small>{t('loadingMusic')}</small>
        </span>
        <span className="app-bootstrap__progress" aria-hidden="true" />
      </main>
    );
  }
  return (
    <MusicProviderRoot
      providers={providers}
      providerOptions={providerOptions}
      initialProviderId={initialProviderId}
    >
      <App />
    </MusicProviderRoot>
  );
}
