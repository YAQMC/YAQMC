import { isNativeRuntime } from './native-player-runtime';
import { productMetadata, type ProductLink } from './product-metadata';
import { getYaqmcClient } from './yaqmc-runtime';

export async function openProductLink(link: ProductLink): Promise<void> {
  const url = productMetadata.links[link];
  if (isNativeRuntime) {
    await getYaqmcClient().host.shell.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Opens an `https:` URL outside the app; plugin and store metadata never get other schemes. */
export async function openExternalUrl(url: string): Promise<void> {
  if (!/^https:\/\/[^\s]+$/i.test(url)) throw new Error('Only https links can be opened');
  if (isNativeRuntime) {
    await getYaqmcClient().host.shell.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
