import { createContext, useContext } from 'react';
import type { MusicProvider } from '../providers/music-provider';

export const ProviderContext = createContext<MusicProvider | null>(null);

export function useMusicProvider(): MusicProvider {
  const provider = useContext(ProviderContext);
  if (!provider) {
    throw new Error('useMusicProvider must be used inside MusicProviderRoot');
  }
  return provider;
}
