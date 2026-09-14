import type { OpenCatalogSongPayload } from '@yaqmc/client';
import type { AppRoute } from './navigation';
import { DEFAULT_PROFILE_ID } from '../domain/music';

const MAX_ENTITY_ID_BYTES = 256;

export function catalogSongRouteFromDeepLink(
  activeProviderId: string,
  payload: OpenCatalogSongPayload,
  activeProfileId?: string,
): AppRoute | null;
export function catalogSongRouteFromDeepLink(
  activeProviderId: string,
  activeProfileId: string,
  payload: OpenCatalogSongPayload,
): AppRoute | null;
export function catalogSongRouteFromDeepLink(
  activeProviderId: string,
  profileOrPayload: string | OpenCatalogSongPayload,
  payloadOrProfile?: OpenCatalogSongPayload | string,
): AppRoute | null {
  const payload = typeof profileOrPayload === 'string' ? payloadOrProfile : profileOrPayload;
  const activeProfileId =
    typeof profileOrPayload === 'string'
      ? profileOrPayload
      : typeof payloadOrProfile === 'string'
        ? payloadOrProfile
        : DEFAULT_PROFILE_ID;
  const linkPayload = typeof payload === 'object' && payload !== null ? payload : null;
  const providerId = typeof linkPayload?.providerId === 'string' ? linkPayload.providerId : '';
  const profileId =
    typeof linkPayload?.profileId === 'string' && linkPayload.profileId
      ? linkPayload.profileId
      : DEFAULT_PROFILE_ID;
  const entityId = typeof linkPayload?.entityId === 'string' ? linkPayload.entityId : '';
  if (
    providerId !== activeProviderId ||
    profileId !== activeProfileId ||
    !entityId ||
    entityId !== entityId.trim() ||
    new TextEncoder().encode(entityId).length > MAX_ENTITY_ID_BYTES ||
    hasControlCharacters(entityId)
  ) {
    return null;
  }
  return { page: 'song', id: entityId, providerId };
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}
