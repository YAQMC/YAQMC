import type { SceneAssetRef } from './lyrics-preset';
import { isNativeRuntime } from './native-player-runtime';
import { readPluginAsset } from './plugin-runtime';

const objectUrls = new Map<string, string>();

export async function resolveSceneAssetUrl(
  asset: SceneAssetRef | undefined,
  enabledPluginId?: string,
): Promise<string | null> {
  if (!asset) return null;
  const pluginId = asset.pluginId ?? enabledPluginId;
  if (asset.kind !== 'plugin' || !pluginId || !isNativeRuntime) return null;
  const key = `${pluginId}:${asset.path}`;
  const cached = objectUrls.get(key);
  if (cached) return cached;
  const payload = await readPluginAsset(pluginId, asset.path);
  if (!payload) return null;
  const bytes = Uint8Array.from(atob(payload.dataBase64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: payload.mime }));
  objectUrls.set(key, url);
  return url;
}
