import { useSyncExternalStore } from 'react';
import type { ActiveSongBadge } from '@yaqmc/client';
import type { ProviderTrackReference } from '../domain/music';

const listeners = new Set<() => void>();
const EMPTY: readonly ActiveSongBadge[] = [];
let badges: readonly ActiveSongBadge[] = EMPTY;
let byProvider = new Map<string, readonly ActiveSongBadge[]>();
const identifier = /^[a-zA-Z0-9._-]{1,128}$/;
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  [...value].length <= 48 &&
  [...value].every(
    (char) =>
      char.codePointAt(0)! >= 32 && (char.codePointAt(0)! < 127 || char.codePointAt(0)! > 159),
  );

function valid(badge: ActiveSongBadge): boolean {
  return Boolean(
    badge &&
    typeof badge.pluginId === 'string' &&
    identifier.test(badge.pluginId) &&
    typeof badge.pluginName === 'string' &&
    badge.pluginName.length <= 80 &&
    typeof badge.id === 'string' &&
    /^[a-zA-Z0-9_-]{1,48}$/.test(badge.id) &&
    text(badge.label) &&
    Array.isArray(badge.providerIds) &&
    badge.providerIds.length > 0 &&
    badge.providerIds.length <= 16 &&
    badge.providerIds.every((id) => typeof id === 'string' && identifier.test(id)) &&
    (badge.color === undefined || /^#[0-9a-fA-F]{6}$/.test(badge.color)) &&
    (badge.labels === undefined ||
      (badge.labels !== null &&
        typeof badge.labels === 'object' &&
        !Array.isArray(badge.labels) &&
        Object.keys(badge.labels).length <= 8 &&
        Object.entries(badge.labels).every(
          ([locale, label]) => /^[a-zA-Z0-9-]{1,35}$/.test(locale) && text(label),
        ))),
  );
}

/** Rebuild a bounded lookup only when the host's active plugin snapshot changes. */
export function replacePluginSongBadges(incoming: readonly ActiveSongBadge[]): void {
  const seen = new Set<string>();
  badges = incoming.slice(0, 128).filter((badge) => {
    if (!valid(badge)) return false;
    const key = `${badge.pluginId}/${badge.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  byProvider = new Map();
  for (const badge of badges) {
    for (const providerId of new Set(badge.providerIds)) {
      const previous = byProvider.get(providerId) ?? EMPTY;
      if (previous.length < 4) byProvider.set(providerId, [...previous, badge]);
    }
  }
  listeners.forEach((listener) => listener());
}

export function clearPluginSongBadges(pluginId?: string): void {
  replacePluginSongBadges(pluginId ? badges.filter((badge) => badge.pluginId !== pluginId) : []);
}

export function songBadgesForProvider(
  provider?: ProviderTrackReference,
): readonly ActiveSongBadge[] {
  const id = provider?.originProviderId ?? provider?.providerId;
  return id ? (byProvider.get(id) ?? EMPTY) : EMPTY;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePluginSongBadges(provider?: ProviderTrackReference): readonly ActiveSongBadge[] {
  return useSyncExternalStore(
    subscribe,
    () => songBadgesForProvider(provider),
    () => EMPTY,
  );
}

export function pluginSongBadgeLabel(badge: ActiveSongBadge, locale: string): string {
  const language = locale.toLowerCase();
  const labels = Object.entries(badge.labels ?? {});
  return (
    labels.find(([key]) => key.toLowerCase() === language)?.[1] ??
    labels.find(([key]) => key.toLowerCase() === language.split('-')[0])?.[1] ??
    badge.label
  );
}
