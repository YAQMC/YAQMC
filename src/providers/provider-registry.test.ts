import { describe, expect, it } from 'vitest';
import { fakeMusicProvider } from './fake/fake-music-provider';
import type { MusicProvider } from './music-provider';
import { MusicProviderRegistry, parseProfileId, parseProviderId } from './provider-registry';

describe('MusicProviderRegistry', () => {
  it('owns runtime IDs and projects legacy provider capabilities', () => {
    const runtimeId = ['plugin', 'fixture-source'].join('.');
    const provider = Object.create(fakeMusicProvider, {
      id: { value: runtimeId, enumerable: true },
    }) as MusicProvider;
    const registry = new MusicProviderRegistry(runtimeId, [provider]);

    expect(registry.activeId).toBe(runtimeId);
    expect(registry.ids()).toEqual([runtimeId]);
    expect(registry.active.catalog).toBe(provider);
    expect(registry.active.profileId).toBe('default');
    expect(registry.active.lyrics).toBe(provider);
    expect(registry.active.recommendations).toBe(true);
    expect(registry.active.account).toBeNull();
    expect(registry.active.legacyProvider).toBe(provider);
    expect(registry.get('plugin/path')).toBeNull();
  });

  it('rejects unsafe IDs, duplicates, and a missing active provider', () => {
    for (const id of ['', 'Uppercase', 'plugin/path', 'plugin:account', 'a'.repeat(65)]) {
      expect(() => parseProviderId(id)).toThrow(/Provider ID/);
    }
    expect(() => new MusicProviderRegistry('missing', [fakeMusicProvider])).toThrow(
      /Active music provider is missing/,
    );
    expect(
      () => new MusicProviderRegistry(fakeMusicProvider.id, [fakeMusicProvider, fakeMusicProvider]),
    ).toThrow(/Duplicate music provider ID\/profile identity/);
  });

  it('applies the Rust profile ID grammar at registry boundaries', () => {
    for (const profileId of ['', 'has space', '\ncontrol', 'Uppercase', 'a'.repeat(65)]) {
      expect(() => parseProfileId(profileId)).toThrow(/Profile ID/);
      expect(
        () =>
          new MusicProviderRegistry('fake', [
            Object.create(fakeMusicProvider, { profileId: { value: profileId } }) as MusicProvider,
          ]),
      ).toThrow(/Profile ID/);
      expect(
        new MusicProviderRegistry('fake', [fakeMusicProvider]).get('fake', profileId),
      ).toBeNull();
    }

    const alternate = Object.create(fakeMusicProvider, {
      profileId: { value: 'alt_profile-1.2', enumerable: true },
    }) as MusicProvider;
    const registry = new MusicProviderRegistry('fake', [fakeMusicProvider, alternate]);
    expect(registry.get('fake', 'alt_profile-1.2')?.profileId).toBe('alt_profile-1.2');
  });

  it('keys providers by provider ID and profile ID while keeping default active lookup', () => {
    const alternate = Object.create(fakeMusicProvider, {
      profileId: { value: 'alternate', enumerable: true },
    }) as MusicProvider;
    const registry = new MusicProviderRegistry('fake', [fakeMusicProvider, alternate]);

    expect(registry.get('fake')?.profileId).toBe('default');
    expect(registry.get('fake', 'alternate')?.profileId).toBe('alternate');
    expect(registry.ids()).toEqual(['fake']);
  });
});
