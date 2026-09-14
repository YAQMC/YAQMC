import { describe, expect, it } from 'vitest';
import { catalogSongRouteFromDeepLink } from './deep-link-navigation';

describe('deep link navigation command', () => {
  it('maps the active provider payload to song details only', () => {
    expect(
      catalogSongRouteFromDeepLink('qqmusic', 'default', {
        profileId: 'default',
        providerId: 'qqmusic',
        entityId: 'qqmusic:track:001',
      }),
    ).toEqual({ page: 'song', id: 'qqmusic:track:001', providerId: 'qqmusic' });
  });

  it('rejects unavailable providers and unsafe entity IDs', () => {
    expect(
      catalogSongRouteFromDeepLink('fake', 'default', {
        providerId: 'qqmusic',
        entityId: 'track',
      }),
    ).toBeNull();
    expect(
      catalogSongRouteFromDeepLink('qqmusic', 'default', {
        providerId: 'qqmusic',
        entityId: 'track\nplay',
      }),
    ).toBeNull();
  });

  it('defaults legacy links to the default profile and rejects a foreign profile', () => {
    expect(
      catalogSongRouteFromDeepLink('qqmusic', 'default', {
        providerId: 'qqmusic',
        entityId: 'qqmusic:track:legacy',
      }),
    ).toEqual({ page: 'song', id: 'qqmusic:track:legacy', providerId: 'qqmusic' });
    expect(
      catalogSongRouteFromDeepLink('qqmusic', 'default', {
        providerId: 'qqmusic',
        profileId: 'alternate',
        entityId: 'qqmusic:track:alternate',
      }),
    ).toBeNull();
    expect(
      catalogSongRouteFromDeepLink('qqmusic', 'alternate', {
        providerId: 'qqmusic',
        profileId: 'alternate',
        entityId: 'qqmusic:track:alternate',
      }),
    ).toEqual({ page: 'song', id: 'qqmusic:track:alternate', providerId: 'qqmusic' });
  });
});
