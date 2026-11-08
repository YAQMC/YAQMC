import { describe, expect, it } from 'vitest';
import type { PluginStoreAsset, PluginStoreRelease } from '@yaqmc/client';
import type { PluginRecord } from './plugin-runtime';
import {
  createLatestGate,
  currentStorePlatform,
  defaultStoreAsset,
  latestInstallableRelease,
  parseStoreError,
  storeInstallState,
  storeSourceRepository,
} from './plugin-store';

const asset = (id: number, name: string): PluginStoreAsset => ({
  id,
  name,
  size: 10,
  downloadCount: 0,
  updatedAt: null,
  sha256: null,
});

const release = (id: number, assets: PluginStoreAsset[]): PluginStoreRelease => ({
  id,
  tagName: `v${id}`,
  name: null,
  body: null,
  publishedAt: null,
  prerelease: false,
  htmlUrl: '',
  assets,
  otherAssetCount: 0,
});

const plugin = (source: string) => ({ id: 'p', source }) as PluginRecord;

describe('plugin store selection rules', () => {
  it('preselects only unambiguous, platform-appropriate packages', () => {
    const single = asset(1, 'music.yaqmc-plugin');
    expect(defaultStoreAsset([single], 'android')).toBe(single);
    expect(defaultStoreAsset([asset(2, 'music-windows.yaqmc-plugin')], 'android')).toBeNull();
    const both = [asset(3, 'music-android.yaqmc-plugin'), asset(4, 'music-linux.yaqmc-plugin')];
    expect(defaultStoreAsset(both, 'android')?.id).toBe(3);
    expect(defaultStoreAsset(both, 'windows')).toBeNull();
    expect(defaultStoreAsset(both, null)).toBeNull();
    // Two packages for different plugins never auto-select the first one.
    expect(
      defaultStoreAsset([asset(5, 'a.yaqmc-plugin'), asset(6, 'b.yaqmc-plugin')], 'linux'),
    ).toBeNull();
    expect(defaultStoreAsset([], 'linux')).toBeNull();
  });

  it('matches installed plugins by recorded store source, not by name', () => {
    expect(storeSourceRepository('github:YAQMC/music/releases/12')).toEqual({
      repository: 'yaqmc/music',
      releaseId: 12,
    });
    expect(storeSourceRepository('local-file')).toBeNull();
    const repository = { fullName: 'YAQMC/music' };
    const latest = release(20, [asset(1, 'x.yaqmc-plugin')]);
    expect(storeInstallState(repository, [plugin('local-file')], latest).installed).toEqual([]);
    expect(
      storeInstallState(repository, [plugin('github:yaqmc/music/releases/12')], latest),
    ).toMatchObject({ candidateUpdate: true });
    expect(
      storeInstallState(repository, [plugin('github:yaqmc/music/releases/20')], latest)
        .candidateUpdate,
    ).toBe(false);
    expect(
      storeInstallState(repository, [plugin('github:other/music/releases/1')], latest).installed,
    ).toEqual([]);
  });

  it('skips releases without packages when finding the latest installable one', () => {
    expect(
      latestInstallableRelease([release(3, []), release(2, [asset(1, 'a.yaqmc-plugin')])])?.id,
    ).toBe(2);
    expect(latestInstallableRelease([release(3, [])])).toBeNull();
  });

  it('maps Core error codes, including rate-limit reset times', () => {
    expect(parseStoreError(new Error('store-rate-limited:1800000000000'))).toMatchObject({
      kind: 'rate-limited',
      resetAtMs: 1_800_000_000_000,
    });
    expect(parseStoreError('store-rate-limited:0').resetAtMs).toBeUndefined();
    expect(parseStoreError('store-offline').kind).toBe('offline');
    expect(parseStoreError('store-asset-digest-mismatch').kind).toBe('digest-mismatch');
    expect(parseStoreError('this plugin does not support android').kind).toBe('other');
  });

  it('lets only the newest request update the view', () => {
    const gate = createLatestGate();
    const first = gate.next();
    const second = gate.next();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it('identifies the host platform for asset hints', () => {
    expect(currentStorePlatform('android', 'Linux; Android')).toBe('android');
    expect(currentStorePlatform('electron', 'Windows NT 10.0')).toBe('windows');
    expect(currentStorePlatform('electron', 'X11; Linux x86_64')).toBe('linux');
  });
});
