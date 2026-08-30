import { createContext, useContext } from 'react';
import type { MusicProvider } from '../providers/music-provider';
import type { MusicProviderRegistry } from '../providers/provider-registry';

export const ProviderContext = createContext<MusicProvider | null>(null);
export const ProviderRegistryContext = createContext<MusicProviderRegistry | null>(null);

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
