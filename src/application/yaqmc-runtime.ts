import {
  CHANNEL_HOST_CORE_STATUS,
  YaqmcClient,
  type CoreStatusPayload,
  type HostBridge,
} from '@yaqmc/client';
import { selectHostBridge } from './tauri-host-bridge';

let hostBridge: HostBridge | undefined;
let yaqmcClient: YaqmcClient | undefined;

export function getHostBridge(): HostBridge {
  hostBridge ??= selectHostBridge();
  return hostBridge;
}

function applyElectronCoreStatus(client: YaqmcClient, payload: unknown): void {
  const status =
    payload !== null && typeof payload === 'object' && 'status' in payload
      ? (payload as CoreStatusPayload).status
      : undefined;
  if (status === 'ready') {
    client.markReady();
    return;
  }
  client.markUnavailable();
}

function attachElectronCoreReady(client: YaqmcClient): void {
  client.on(CHANNEL_HOST_CORE_STATUS, (payload) => {
    applyElectronCoreStatus(client, payload);
  });
  const invokeHost = client.bridge.invoke as unknown as (method: string) => Promise<unknown>;
  void invokeHost('host.coreStatus')
    .then((payload) => {
      applyElectronCoreStatus(client, payload);
    })
    .catch(() => {
      // Probe is best-effort; host://core-status still unblocks.
    });
}

export function getYaqmcClient(): YaqmcClient {
  if (!yaqmcClient) {
    const bridge = getHostBridge();
    yaqmcClient = new YaqmcClient(bridge);
    // Tauri invoke is already live; fake is local. Electron waits for core-status.
    if (bridge.kind === 'electron') {
      attachElectronCoreReady(yaqmcClient);
    } else {
      yaqmcClient.markReady();
    }
  }
  return yaqmcClient;
}
