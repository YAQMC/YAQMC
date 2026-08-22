export type LyricsSurfaceWindowRole = 'lyrics-desktop' | 'lyrics-island';
export type UnlockOverlayWindowRole = 'unlock-desktop' | 'unlock-island';

export function searchFromLocation(location: { search?: string } | undefined): string {
  return typeof location?.search === 'string' ? location.search : '';
}

export function lyricsWindowRoleFromSearch(search: string): LyricsSurfaceWindowRole {
  return new URLSearchParams(search).get('surface') === 'island'
    ? 'lyrics-island'
    : 'lyrics-desktop';
}

export function unlockWindowRoleFromSearch(search: string): UnlockOverlayWindowRole {
  return new URLSearchParams(search).get('unlockSurface') === 'island'
    ? 'unlock-island'
    : 'unlock-desktop';
}
