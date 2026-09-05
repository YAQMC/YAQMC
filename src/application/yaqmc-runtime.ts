import {
  CHANNEL_HOST_CORE_STATUS,
  YaqmcClient,
  type CoreStatusPayload,
  type HostBridge,
} from '@yaqmc/client';
import { selectHostBridge } from './renderer-host-bridge';

let hostBridge: HostBridge | undefined;
let yaqmcClient: YaqmcClient | undefined;

export function getHostBridge(): HostBridge {
  hostBridge ??= selectHostBridge();
  return hostBridge;
}

function applyCoreStatus(client: YaqmcClient, payload: unknown): boolean {
  const status =
    payload !== null && typeof payload === 'object' && 'status' in payload
      ? (payload as CoreStatusPayload).status
      : undefined;
  if (status === 'ready') {
    client.markReady();
    return true;
  }
  client.markUnavailable();
  return false;
}

function attachNativeCoreReady(client: YaqmcClient): void {
  let ready = false;
  const apply = (payload: unknown) => {
    const becameReady = applyCoreStatus(client, payload);
    if (becameReady && !ready) void client.resync().catch(() => undefined);
    ready = becameReady;
  };
  client.on(CHANNEL_HOST_CORE_STATUS, (payload) => {
    apply(payload);
  });
  const invokeHost = client.bridge.invoke as unknown as (method: string) => Promise<unknown>;
  void invokeHost('host.coreStatus')
    .then((payload) => {
      apply(payload);
    })
    .catch(() => {
      // Probe is best-effort; host://core-status still unblocks.
    });
}

export function getYaqmcClient(): YaqmcClient {
  if (!yaqmcClient) {
    const bridge = getHostBridge();
    yaqmcClient = new YaqmcClient(bridge);
    // Fake is local. Electron waits for core-status.
    if (bridge.kind === 'electron' || bridge.kind === 'android') {
      attachNativeCoreReady(yaqmcClient);
    } else {
      yaqmcClient.markReady();
    }
  }
  return yaqmcClient;
}
