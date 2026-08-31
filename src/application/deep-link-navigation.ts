import type { OpenCatalogSongPayload } from '@yaqmc/client';
import type { AppRoute } from './navigation';

const MAX_ENTITY_ID_BYTES = 256;

export function catalogSongRouteFromDeepLink(
  activeProviderId: string,
  payload: OpenCatalogSongPayload,
): AppRoute | null {
  const providerId = typeof payload?.providerId === 'string' ? payload.providerId : '';
  const entityId = typeof payload?.entityId === 'string' ? payload.entityId : '';
  if (
    providerId !== activeProviderId ||
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
