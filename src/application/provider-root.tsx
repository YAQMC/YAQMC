import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { AccountDialog } from '../components/AccountDialog';
import type { MusicProvider } from '../providers/music-provider';
import { MusicProviderRegistry } from '../providers/provider-registry';
import { useAccountRuntime } from './account-runtime';
import {
  ProviderContext,
  ProviderRegistryContext,
  ProviderSelectionContext,
  type MusicProviderOption,
} from './provider-context';

const ACTIVE_PROVIDER_KEY = 'yaqmc.active-provider.v1';

interface MusicProviderRootProps {
  provider?: MusicProvider;
  providers?: readonly MusicProvider[];
  providerOptions?: readonly MusicProviderOption[];
  initialProviderId?: string;
  children: ReactNode;
}

export function MusicProviderRoot({
  provider,
  providers,
  providerOptions,
  initialProviderId,
  children,
}: MusicProviderRootProps) {
  const providerList = useMemo(
    () => providers ?? (provider ? [provider] : []),
    [provider, providers],
  );
  if (providerList.length === 0) throw new Error('MusicProviderRoot requires a provider.');
  const [activeId, setActiveId] = useState(() => {
    const available = new Set(providerList.map((candidate) => candidate.id));
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(ACTIVE_PROVIDER_KEY);
    } catch {
      // Storage may be unavailable in hardened or test runtimes.
    }
    return [initialProviderId, saved, providerList[0]?.id].find(
      (candidate): candidate is string => typeof candidate === 'string' && available.has(candidate),
    )!;
  });
  const effectiveActiveId = providerList.some((candidate) => candidate.id === activeId)
    ? activeId
    : providerList[0]!.id;
  const registry = useMemo(
    () => new MusicProviderRegistry(effectiveActiveId, providerList),
    [effectiveActiveId, providerList],
  );
  const activeProvider = registry.active.legacyProvider;
  useAccountRuntime(activeProvider);
  const selectProvider = useCallback(
    (id: string) => {
      if (!providerList.some((candidate) => candidate.id === id)) return;
      setActiveId(id);
      try {
        window.localStorage.setItem(ACTIVE_PROVIDER_KEY, id);
      } catch {
        // The in-memory selection remains authoritative for this session.
      }
    },
    [providerList],
  );
  const selection = useMemo(
    () => ({
      activeId: effectiveActiveId,
      providers:
        providerOptions ??
        providerList.map((candidate) => ({
          id: candidate.id,
          displayName: candidate.displayName,
          available: true,
        })),
      selectProvider,
    }),
    [effectiveActiveId, providerList, providerOptions, selectProvider],
  );
  return (
    <ProviderRegistryContext value={registry}>
      <ProviderSelectionContext value={selection}>
        <ProviderContext value={activeProvider}>
          {children}
          <AccountDialog />
        </ProviderContext>
      </ProviderSelectionContext>
    </ProviderRegistryContext>
  );
}
