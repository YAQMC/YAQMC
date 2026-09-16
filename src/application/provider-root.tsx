import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccountDialog } from '../components/AccountDialog';
import type { MusicProvider } from '../providers/music-provider';
import { isProfileId, isProviderId, MusicProviderRegistry } from '../providers/provider-registry';
import { DEFAULT_PROFILE_ID } from '../domain/music';
import { useAccountRuntime } from './account-runtime';
import {
  ProviderContext,
  ProviderRegistryContext,
  ProviderSelectionContext,
  type ActiveProviderSelection,
  type MusicProviderOption,
} from './provider-context';

const ACTIVE_PROVIDER_PROFILE_KEY = 'yaqmc.active-provider-profile.v2';
const LEGACY_ACTIVE_PROVIDER_KEY = 'yaqmc.active-provider.v1';

interface MusicProviderRootProps {
  provider?: MusicProvider;
  providers?: readonly MusicProvider[];
  providerOptions?: readonly MusicProviderOption[];
  initialProviderId?: string;
  initialProviderProfile?: ActiveProviderSelection;
  children: ReactNode;
}

function providerSelectionKey(selection: ActiveProviderSelection): string {
  return `${selection.providerId}\0${selection.profileId}`;
}

function providerIdentity(provider: MusicProvider): ActiveProviderSelection {
  return { providerId: provider.id, profileId: provider.profileId };
}

function readStoredSelection(): ActiveProviderSelection | null {
  try {
    const v2 = window.localStorage.getItem(ACTIVE_PROVIDER_PROFILE_KEY);
    if (v2 !== null) {
      const parsed: unknown = JSON.parse(v2);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as { providerId?: unknown }).providerId === 'string' &&
        typeof (parsed as { profileId?: unknown }).profileId === 'string'
      ) {
        const { providerId, profileId } = parsed as {
          providerId: string;
          profileId: string;
        };
        if (isProviderId(providerId) && isProfileId(profileId)) {
          return { providerId, profileId };
        }
      }
      return null;
    }
    const legacy = window.localStorage.getItem(LEGACY_ACTIVE_PROVIDER_KEY);
    if (!legacy || !isProviderId(legacy)) return null;
    return { providerId: legacy, profileId: DEFAULT_PROFILE_ID };
  } catch {
    // Storage may be unavailable or contain malformed JSON.
    return null;
  }
}

function persistSelection(selection: ActiveProviderSelection): void {
  try {
    window.localStorage.setItem(ACTIVE_PROVIDER_PROFILE_KEY, JSON.stringify(selection));
    // Keep the provider-only key in sync for older renderer versions.
    window.localStorage.setItem(LEGACY_ACTIVE_PROVIDER_KEY, selection.providerId);
  } catch {
    // The in-memory selection remains authoritative for this session.
  }
}

export function MusicProviderRoot({
  provider,
  providers,
  providerOptions,
  initialProviderId,
  initialProviderProfile,
  children,
}: MusicProviderRootProps) {
  const providerList = useMemo(
    () => providers ?? (provider ? [provider] : []),
    [provider, providers],
  );
  if (providerList.length === 0) throw new Error('MusicProviderRoot requires a provider.');
  const [activeSelection, setActiveSelection] = useState<ActiveProviderSelection>(() => {
    const available = new Set(
      providerList.map((candidate) => providerSelectionKey(providerIdentity(candidate))),
    );
    const initial =
      initialProviderProfile ??
      (initialProviderId ? { providerId: initialProviderId, profileId: DEFAULT_PROFILE_ID } : null);
    const saved = readStoredSelection();
    const fallback = providerList[0]!;
    const candidates = [
      initial,
      saved,
      {
        providerId: fallback.id,
        profileId: fallback.profileId,
      },
    ];
    return candidates.find(
      (candidate): candidate is ActiveProviderSelection =>
        candidate !== null &&
        isProviderId(candidate.providerId) &&
        isProfileId(candidate.profileId) &&
        available.has(providerSelectionKey(candidate)),
    )!;
  });
  const effectiveActiveSelection = useMemo(
    () =>
      providerList.some(
        (candidate) =>
          providerSelectionKey(providerIdentity(candidate)) ===
          providerSelectionKey(activeSelection),
      )
        ? activeSelection
        : { providerId: providerList[0]!.id, profileId: providerList[0]!.profileId },
    [activeSelection, providerList],
  );
  useEffect(() => {
    const activeKey = providerSelectionKey(activeSelection);
    const effectiveKey = providerSelectionKey(effectiveActiveSelection);
    if (activeKey !== effectiveKey) {
      persistSelection(effectiveActiveSelection);
      let disposed = false;
      queueMicrotask(() => {
        if (!disposed) setActiveSelection(effectiveActiveSelection);
      });
      return () => {
        disposed = true;
      };
    }
    // Migrate v1 only after the legacy identity has been confirmed as an
    // available provider/profile. Unknown legacy values remain harmless.
    try {
      if (
        window.localStorage.getItem(ACTIVE_PROVIDER_PROFILE_KEY) === null &&
        window.localStorage.getItem(LEGACY_ACTIVE_PROVIDER_KEY) ===
          effectiveActiveSelection.providerId &&
        effectiveActiveSelection.profileId === DEFAULT_PROFILE_ID
      ) {
        persistSelection(effectiveActiveSelection);
      }
    } catch {
      // Storage may be unavailable in hardened or test runtimes.
    }
  }, [activeSelection, effectiveActiveSelection]);
  const registry = useMemo(
    () => new MusicProviderRegistry(effectiveActiveSelection, providerList),
    [effectiveActiveSelection, providerList],
  );
  const activeProvider = registry.active.legacyProvider;
  useAccountRuntime(activeProvider);
  const selectProvider = useCallback(
    (id: string) => {
      if (!providerList.some((candidate) => candidate.id === id)) return;
      const candidate = providerList.find(
        (provider) => provider.id === id && provider.profileId === DEFAULT_PROFILE_ID,
      );
      if (!candidate) return;
      const next = { providerId: candidate.id, profileId: candidate.profileId };
      setActiveSelection(next);
      persistSelection(next);
    },
    [providerList],
  );
  const selectProviderProfile = useCallback(
    (selectionOrProviderId: ActiveProviderSelection | string, profileId?: string) => {
      const next =
        typeof selectionOrProviderId === 'string'
          ? { providerId: selectionOrProviderId, profileId: profileId ?? DEFAULT_PROFILE_ID }
          : selectionOrProviderId;
      const candidate = providerList.find(
        (provider) => provider.id === next.providerId && provider.profileId === next.profileId,
      );
      if (!candidate) return;
      const normalized = { providerId: candidate.id, profileId: candidate.profileId };
      setActiveSelection(normalized);
      persistSelection(normalized);
    },
    [providerList],
  );
  const selection = useMemo(
    () => ({
      active: effectiveActiveSelection,
      activeSelection: effectiveActiveSelection,
      activeId: effectiveActiveSelection.providerId,
      activeProfileId: effectiveActiveSelection.profileId,
      providers:
        providerOptions ??
        providerList.map((candidate) => ({
          id: candidate.id,
          profileId: candidate.profileId,
          displayName: candidate.displayName,
          available: true,
        })),
      selectProvider,
      selectProviderProfile,
    }),
    [
      effectiveActiveSelection,
      providerList,
      providerOptions,
      selectProvider,
      selectProviderProfile,
    ],
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
