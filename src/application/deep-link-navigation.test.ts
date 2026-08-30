import { describe, expect, it } from 'vitest';
import { catalogSongRouteFromDeepLink } from './deep-link-navigation';

describe('deep link navigation command', () => {
  it('maps the active provider payload to song details only', () => {
    expect(
      catalogSongRouteFromDeepLink('qqmusic', {
        providerId: 'qqmusic',
        entityId: 'qqmusic:track:001',
      }),
    ).toEqual({ page: 'song', id: 'qqmusic:track:001' });
  });

  it('rejects unavailable providers and unsafe entity IDs', () => {
    expect(
      catalogSongRouteFromDeepLink('fake', {
        providerId: 'qqmusic',
        entityId: 'track',
      }),
    ).toBeNull();
    expect(
      catalogSongRouteFromDeepLink('qqmusic', {
        providerId: 'qqmusic',
        entityId: 'track\nplay',
      }),
    ).toBeNull();
  });
});
