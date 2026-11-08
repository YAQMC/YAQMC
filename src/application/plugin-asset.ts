import { useSyncExternalStore } from 'react';
import type { SceneAssetRef } from './lyrics-preset';
import { isNativeRuntime } from './native-player-runtime';
import { getYaqmcClient } from './yaqmc-runtime';

interface PluginAssets {
  fingerprint: string;
  urls: Map<string, string>;
  pending: Map<string, Promise<string | null>>;
}

const plugins = new Map<string, PluginAssets>();
const listeners = new Set<() => void>();
let revision = 0;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => revision;

export function usePluginAssetRevision(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function notify(): void {
  revision += 1;
  listeners.forEach((listener) => listener());
}

function retire(id: string): boolean {
  const assets = plugins.get(id);
  if (!assets) return false;
  plugins.delete(id);
  for (const url of assets.urls.values()) URL.revokeObjectURL(url);
  assets.urls.clear();
  assets.pending.clear();
  return true;
}

export function invalidatePluginAssets(pluginId?: string): void {
  let changed = false;
  for (const id of pluginId ? [pluginId] : [...plugins.keys()]) {
    changed = retire(id) || changed;
  }
  if (changed) notify();
}

/** Only the latest host snapshot can re-authorize reads after retirement. */
export function syncPluginAssetAccess(active: ReadonlyMap<string, string>): void {
  let changed = false;
  for (const [id, assets] of plugins) {
    if (active.get(id) !== assets.fingerprint) changed = retire(id) || changed;
  }
  for (const [id, fingerprint] of active) {
    if (plugins.has(id)) continue;
    plugins.set(id, { fingerprint, urls: new Map(), pending: new Map() });
    changed = true;
  }
  if (changed) notify();
}

export async function resolveSceneAssetUrl(
  asset: SceneAssetRef | undefined,
  enabledPluginId?: string,
): Promise<string | null> {
  if (!asset) return null;
  const pluginId = asset.pluginId ?? enabledPluginId;
  if (asset.kind !== 'plugin' || !pluginId || !isNativeRuntime) return null;
  const assets = plugins.get(pluginId);
  if (!assets) return null;
  const cached = assets.urls.get(asset.path);
  if (cached) return cached;
  const pending = assets.pending.get(asset.path);
  if (pending) return pending;
  const task = Promise.resolve().then(async () => {
    try {
      const payload = await getYaqmcClient().invoke('plugin_read_asset', {
        pluginId,
        path: asset.path,
      });
      // A disable/update can finish while the asset read is still in flight.
      if (!payload || plugins.get(pluginId) !== assets) return null;
      const bytes = Uint8Array.from(atob(payload.dataBase64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: payload.mime }));
      assets.urls.set(asset.path, url);
      return url;
    } catch {
      return null;
    } finally {
      assets.pending.delete(asset.path);
    }
  });
  assets.pending.set(asset.path, task);
  return task;
}
