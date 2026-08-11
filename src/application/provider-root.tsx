import type { ReactNode } from 'react';
import { AccountDialog } from '../components/AccountDialog';
import type { MusicProvider } from '../providers/music-provider';
import { useAccountRuntime } from './account-runtime';
import { ProviderContext } from './provider-context';

interface MusicProviderRootProps {
  provider: MusicProvider;
  children: ReactNode;
}

export function MusicProviderRoot({ provider, children }: MusicProviderRootProps) {
  useAccountRuntime(provider);
  return (
    <ProviderContext value={provider}>
      {children}
      <AccountDialog />
    </ProviderContext>
  );
}
