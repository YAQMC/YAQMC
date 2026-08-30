import { createContext, useContext } from 'react';
import type { ProviderCapabilitySummary } from '@yaqmc/client';
import type { MusicProvider } from '../providers/music-provider';
import type { MusicProviderRegistry } from '../providers/provider-registry';

export type MusicProviderOption = Pick<MusicProvider, 'id' | 'displayName'> & {
  available: boolean;
  capabilities?: ProviderCapabilitySummary;
};

export interface MusicProviderSelection {
  activeId: string;
  providers: readonly MusicProviderOption[];
  selectProvider(id: string): void;
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
  if (selection) return selection;
  if (legacyProvider) {
    return {
      activeId: legacyProvider.id,
      providers: [
        {
          id: legacyProvider.id,
          displayName: legacyProvider.displayName,
          available: true,
        },
      ],
      selectProvider: () => undefined,
    };
  }
  throw new Error('useMusicProviderSelection must be used inside MusicProviderRoot');
}
