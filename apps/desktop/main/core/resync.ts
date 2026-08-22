import {
  YaqmcClient,
  type HostBridge,
  type HostShellBridge,
  type HostWindowBridge,
} from '@yaqmc/client';
import type { CoreClient } from './client';

function noopWindow(): HostWindowBridge {
  return {
    minimize: async () => undefined,
    toggleMaximize: async () => undefined,
    close: async () => undefined,
    setFullscreen: async () => undefined,
  };
}

function noopShell(): HostShellBridge {
  return {
    openExternal: async () => undefined,
  };
}

export function hostBridgeFromCoreClient(client: CoreClient): HostBridge {
  return {
    kind: 'electron',
    windowRole: 'main',
    window: noopWindow(),
    shell: noopShell(),
    invoke: ((method, ...params) => client.invoke(method, params[0])) as HostBridge['invoke'],
    listen: () => () => undefined,
  };
}

/**
 * After a crash restart, pull the §14.5 set through `YaqmcClient.resync()` and
 * leave playback paused. Never auto-resume audio.
 */
export async function resyncAfterCoreRestart(client: CoreClient) {
  try {
    await client.invoke('player_pause');
  } catch {
    // Core may already be paused or the method may fail; still resync.
  }
  const yaqmc = new YaqmcClient(hostBridgeFromCoreClient(client));
  yaqmc.markReady();
  try {
    return await yaqmc.resync();
  } finally {
    yaqmc.dispose();
  }
}
