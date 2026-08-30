import { describe, expect, it } from 'vitest';
import { fakeMusicProvider } from './fake/fake-music-provider';
import type { MusicProvider } from './music-provider';
import { MusicProviderRegistry, parseProviderId } from './provider-registry';

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
    expect(registry.active.lyrics).toBe(provider);
    expect(registry.active.recommendations).toBe(provider);
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
    ).toThrow(/Duplicate music provider ID/);
  });
});
