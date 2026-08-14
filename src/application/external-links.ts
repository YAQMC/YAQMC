import { openUrl } from '@tauri-apps/plugin-opener';
import { isNativeRuntime } from './native-player-runtime';
import { productMetadata, type ProductLink } from './product-metadata';

export async function openProductLink(link: ProductLink): Promise<void> {
  const url = productMetadata.links[link];
  if (isNativeRuntime) {
    await openUrl(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
