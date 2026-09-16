import {
  CHANNEL_HOST_CORE_STATUS,
  CHANNEL_PLUGIN_CHANGED,
  CHANNEL_PROVIDER_PROFILES_CHANGED,
} from '@yaqmc/client';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import App from '../App';
import type { MusicProvider } from '../providers/music-provider';
import { createNativeMusicProvider } from '../providers/native/native-music-provider';
import { qqMusicProvider } from '../providers/qqmusic/qq-music-provider';
import {
  buildNativeProviderSnapshot,
  isValidProviderProfile,
  legacyProviderProfiles,
  resolveNativeProviderProfiles,
  type NativeProviderSnapshot,
} from './native-provider-profiles';
import { MusicProviderRoot } from './provider-root';
import { getYaqmcClient } from './yaqmc-runtime';

export function NativeApplication({ initialProviderId }: { initialProviderId?: string }) {
  const { t } = useTranslation('pages');
  const [snapshot, setSnapshot] = useState<NativeProviderSnapshot | null>(null);
  useEffect(() => {
    const client = getYaqmcClient();
    let generation = 0;
    const reload = () => {
      const requestGeneration = ++generation;
      void Promise.allSettled([
        client.invoke('provider_list'),
        client.invoke('provider_profile_list'),
      ]).then(([descriptorResult, profileResult]) => {
        if (requestGeneration !== generation) return;
        if (descriptorResult.status === 'rejected') {
          setSnapshot({ descriptors: [], profiles: [] });
          return;
        }
        const descriptors = Array.isArray(descriptorResult.value) ? descriptorResult.value : [];
        const profiles =
          profileResult.status === 'fulfilled' && Array.isArray(profileResult.value)
            ? profileResult.value.filter(isValidProviderProfile)
            : legacyProviderProfiles(descriptors);
        setSnapshot(buildNativeProviderSnapshot(descriptors, profiles));
      });
    };
    reload();
    const stopPluginChanged = client.on(CHANNEL_PLUGIN_CHANGED, reload);
    const stopCoreStatus = client.on(CHANNEL_HOST_CORE_STATUS, (payload) => {
      if (payload.status === 'ready') reload();
    });
    const stopProfilesChanged = client.on(CHANNEL_PROVIDER_PROFILES_CHANGED, reload);
    return () => {
      generation += 1;
      stopPluginChanged();
      stopCoreStatus();
      stopProfilesChanged();
    };
  }, []);
  const descriptors = snapshot?.descriptors ?? null;
  const providers = useMemo<MusicProvider[]>(() => {
    const active = descriptors
      ?.filter((descriptor) => descriptor.available && descriptor.capabilities.catalog)
      .flatMap((descriptor) =>
        resolveNativeProviderProfiles(descriptor, snapshot?.profiles ?? []).map((profile) =>
          createNativeMusicProvider(
            { ...descriptor, displayName: profile.label || descriptor.displayName },
            profile.profileId,
          ),
        ),
      );
    return active && active.length > 0 ? active : [qqMusicProvider];
  }, [descriptors, snapshot?.profiles]);
  const providerOptions = useMemo(() => {
    const options = descriptors
      ?.filter((descriptor) => descriptor.capabilities.catalog)
      .flatMap((descriptor) => {
        const profiles = snapshot?.profiles.filter(
          (profile) => profile.providerId === descriptor.providerId,
        );
        return (profiles?.length ? profiles : legacyProviderProfiles([descriptor])).map(
          (profile) => ({
            id: descriptor.providerId,
            profileId: profile.profileId,
            displayName: profile.label || descriptor.displayName,
            available: descriptor.available && profile.enabled,
            capabilities: descriptor.capabilities,
          }),
        );
      });
    return options && options.length > 0 ? options : undefined;
  }, [descriptors, snapshot?.profiles]);
  if (snapshot === null) {
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
