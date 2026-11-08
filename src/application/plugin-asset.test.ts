import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  invalidatePluginAssets,
  resolveSceneAssetUrl,
  syncPluginAssetAccess,
} from './plugin-asset';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('./native-player-runtime', () => ({ isNativeRuntime: true }));
vi.mock('./yaqmc-runtime', () => ({ getYaqmcClient: () => ({ invoke }) }));
const asset = { kind: 'plugin' as const, path: 'assets/one.png' };
const payload = { mime: 'image/png', dataBase64: btoa('image') };
const create = vi.fn();
const revoke = vi.fn();
beforeEach(() => {
  let count = 0;
  create.mockReset().mockImplementation(() => `blob:asset-${++count}`);
  revoke.mockReset();
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }),
  );
  invoke.mockReset().mockResolvedValue(payload);
  syncPluginAssetAccess(new Map([['plugin', 'v1']]));
});
afterEach(() => {
  invalidatePluginAssets();
  vi.unstubAllGlobals();
});

it('shares concurrent reads and revokes every owned URL on retirement', async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () => resolveSceneAssetUrl(asset, 'plugin')),
  );
  expect(new Set(results).size).toBe(1);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledTimes(1);
  await resolveSceneAssetUrl({ ...asset, path: 'assets/two.png' }, 'plugin');
  invalidatePluginAssets('plugin');
  expect(revoke).toHaveBeenCalledTimes(2);
  expect(await resolveSceneAssetUrl(asset, 'plugin')).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('drops stale completions, including after the same plugin is enabled again', async () => {
  let finish!: (value: typeof payload) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = resolveSceneAssetUrl(asset, 'plugin');
  await Promise.resolve();
  invalidatePluginAssets('plugin');
  syncPluginAssetAccess(new Map([['plugin', 'v1']]));
  const fresh = await resolveSceneAssetUrl(asset, 'plugin');
  finish(payload);
  expect(await pending).toBeNull();
  expect(await resolveSceneAssetUrl(asset, 'plugin')).toBe(fresh);
  expect(create).toHaveBeenCalledTimes(1);
});

it('keeps unchanged resources and refreshes an updated package', async () => {
  const old = await resolveSceneAssetUrl(asset, 'plugin');
  syncPluginAssetAccess(new Map([['plugin', 'v1']]));
  expect(await resolveSceneAssetUrl(asset, 'plugin')).toBe(old);
  syncPluginAssetAccess(new Map([['plugin', 'v2']]));
  expect(revoke).toHaveBeenCalledWith(old);
  expect(await resolveSceneAssetUrl(asset, 'plugin')).not.toBe(old);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('retries failed reads and isolates plugins with the same asset path', async () => {
  invoke.mockRejectedValueOnce(new Error('read failed'));
  expect(await resolveSceneAssetUrl(asset, 'plugin')).toBeNull();
  const one = await resolveSceneAssetUrl(asset, 'plugin');
  syncPluginAssetAccess(
    new Map([
      ['plugin', 'v1'],
      ['other', 'v1'],
    ]),
  );
  const other = await resolveSceneAssetUrl(asset, 'other');
  expect(one).not.toBe(other);
  invalidatePluginAssets('plugin');
  expect(await resolveSceneAssetUrl(asset, 'other')).toBe(other);
});
