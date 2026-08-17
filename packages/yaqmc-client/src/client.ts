import type { HostBridge } from './bridge';

export class YaqmcClient {
  constructor(readonly bridge: HostBridge) {}
}
