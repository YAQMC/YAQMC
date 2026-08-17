import { YaqmcClient, type HostBridge } from '@yaqmc/client';
import { selectHostBridge } from './tauri-host-bridge';

let hostBridge: HostBridge | undefined;
let yaqmcClient: YaqmcClient | undefined;

export function getHostBridge(): HostBridge {
  hostBridge ??= selectHostBridge();
  return hostBridge;
}

export function getYaqmcClient(): YaqmcClient {
  if (!yaqmcClient) {
    const bridge = getHostBridge();
    yaqmcClient = new YaqmcClient(bridge);
    // Tauri invoke is already live; fake is local. Electron waits for core-status (P5).
    if (bridge.kind !== 'electron') {
      yaqmcClient.markReady();
    }
  }
  return yaqmcClient;
}
