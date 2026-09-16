import { createContext, useContext, useMemo } from 'react';
import type { ProviderCapabilitySummary } from '@yaqmc/client';
import type { MusicProvider } from '../providers/music-provider';
import type { MusicProviderRegistry } from '../providers/provider-registry';

export type MusicProviderOption = Pick<MusicProvider, 'id' | 'displayName'> & {
  profileId?: string;
  available: boolean;
  capabilities?: ProviderCapabilitySummary;
};

export interface ActiveProviderSelection {
  providerId: string;
  profileId: string;
}

export interface MusicProviderSelection {
  /** Exact active provider/profile identity. */
  active: ActiveProviderSelection;
  /** Alias for callers that prefer the explicit name. */
  activeSelection: ActiveProviderSelection;
  /** @deprecated Use active.providerId. */
  activeId: string;
  /** @deprecated Use active.profileId. */
  activeProfileId: string;
  providers: readonly MusicProviderOption[];
  selectProvider(id: string): void;
  selectProviderProfile(selection: ActiveProviderSelection): void;
  selectProviderProfile(providerId: string, profileId: string): void;
}

export const ProviderContext = createContext<MusicProvider | null>(null);
export const ProviderRegistryContext = createContext<MusicProviderRegistry | null>(null);
export const ProviderSelectionContext = createContext<MusicProviderSelection | null>(null);

export function useMusicProvider(): MusicProvider {
  const provider = useContext(ProviderContext);
  if (!provider) {
    throw new Error('useMusicProvider must be used inside MusicProviderRoot');
  }
  return provider;
}

export function useMusicProviderRegistry(): MusicProviderRegistry {
  const registry = useContext(ProviderRegistryContext);
  if (!registry) {
    throw new Error('useMusicProviderRegistry must be used inside MusicProviderRoot');
  }
  return registry;
}

export function useMusicProviderSelection(): MusicProviderSelection {
  const selection = useContext(ProviderSelectionContext);
  const legacyProvider = useContext(ProviderContext);
  return useMemo(() => {
    if (selection) return selection;
    if (legacyProvider) {
      return {
        active: { providerId: legacyProvider.id, profileId: legacyProvider.profileId },
        activeSelection: { providerId: legacyProvider.id, profileId: legacyProvider.profileId },
        activeId: legacyProvider.id,
        activeProfileId: legacyProvider.profileId,
        providers: [
          {
            id: legacyProvider.id,
            profileId: legacyProvider.profileId,
            displayName: legacyProvider.displayName,
            available: true,
          },
        ],
        selectProvider: () => undefined,
        selectProviderProfile: () => undefined,
      };
    }
    throw new Error('useMusicProviderSelection must be used inside MusicProviderRoot');
  }, [legacyProvider, selection]);
}

export function useMusicProviderAvailability(): (providerId: string | null | undefined) => boolean {
  const selection = useContext(ProviderSelectionContext);
  const legacyProvider = useContext(ProviderContext);

  return (providerId) => {
    const normalizedId = providerId?.trim() ?? '';
    if (!normalizedId) return true;
    if (selection) {
      // TODO(B2): expose profile-aware availability once provider options carry
      // the native profile descriptors; queue metadata is provider-only today.
      return selection.providers.some(
        (candidate) => candidate.id === normalizedId && candidate.available,
      );
    }
    if (legacyProvider) return legacyProvider.id === normalizedId;
    return true;
  };
}
