import type { ProviderDescriptor, ProviderProfileDescriptor } from '@yaqmc/client';
import { isProfileId } from '../providers/provider-registry';

export interface NativeProviderSnapshot {
  descriptors: ProviderDescriptor[];
  profiles: ProviderProfileDescriptor[];
}

function validProfile(profile: ProviderProfileDescriptor): boolean {
  return (
    typeof profile.providerId === 'string' &&
    isProfileId(profile.profileId) &&
    typeof profile.label === 'string' &&
    typeof profile.enabled === 'boolean'
  );
}

function legacyProfiles(descriptors: readonly ProviderDescriptor[]): ProviderProfileDescriptor[] {
  return descriptors.map((descriptor) => ({
    providerId: descriptor.providerId,
    profileId: 'default',
    label: descriptor.displayName,
    enabled: true,
  }));
}

export function buildNativeProviderSnapshot(
  descriptors: readonly ProviderDescriptor[],
  profiles: readonly ProviderProfileDescriptor[],
): NativeProviderSnapshot {
  const normalizedDescriptors = descriptors.filter(
    (descriptor) => descriptor && typeof descriptor.providerId === 'string',
  );
  const providerIds = new Set(normalizedDescriptors.map((descriptor) => descriptor.providerId));
  return {
    descriptors: [...normalizedDescriptors],
    profiles: profiles.filter(
      (profile) => validProfile(profile) && providerIds.has(profile.providerId),
    ),
  };
}

/** Resolve enabled profiles while retaining plugin providers on legacy Core. */
export function resolveNativeProviderProfiles(
  descriptor: ProviderDescriptor,
  profiles: readonly ProviderProfileDescriptor[],
): ProviderProfileDescriptor[] {
  const explicit = profiles.filter((profile) => profile.providerId === descriptor.providerId);
  if (explicit.length === 0) return legacyProfiles([descriptor]);
  const seen = new Set<string>();
  return explicit.filter((profile) => {
    if (
      profile.providerId !== descriptor.providerId ||
      !profile.enabled ||
      seen.has(profile.profileId)
    ) {
      return false;
    }
    seen.add(profile.profileId);
    return true;
  });
}

export function legacyProviderProfiles(
  descriptors: readonly ProviderDescriptor[],
): ProviderProfileDescriptor[] {
  return legacyProfiles(descriptors);
}

export function isValidProviderProfile(profile: ProviderProfileDescriptor): boolean {
  return validProfile(profile);
}
