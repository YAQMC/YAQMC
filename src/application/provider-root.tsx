import type { ReactNode } from 'react';
import type { MusicProvider } from '../providers/music-provider';
import { ProviderContext } from './provider-context';

interface MusicProviderRootProps {
  provider: MusicProvider;
  children: ReactNode;
}

export function MusicProviderRoot({ provider, children }: MusicProviderRootProps) {
  return <ProviderContext value={provider}>{children}</ProviderContext>;
}
