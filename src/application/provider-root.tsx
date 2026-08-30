import { useMemo, type ReactNode } from 'react';
import { AccountDialog } from '../components/AccountDialog';
import type { MusicProvider } from '../providers/music-provider';
import { MusicProviderRegistry } from '../providers/provider-registry';
import { useAccountRuntime } from './account-runtime';
import { ProviderContext, ProviderRegistryContext } from './provider-context';

interface MusicProviderRootProps {
  provider: MusicProvider;
  children: ReactNode;
}

export function MusicProviderRoot({ provider, children }: MusicProviderRootProps) {
  useAccountRuntime(provider);
  const registry = useMemo(() => new MusicProviderRegistry(provider.id, [provider]), [provider]);
  return (
    <ProviderRegistryContext value={registry}>
      <ProviderContext value={registry.active.legacyProvider}>
        {children}
        <AccountDialog />
      </ProviderContext>
    </ProviderRegistryContext>
  );
}
