import type { HostBridge } from '../bridge';

export function createElectronBridge(): HostBridge {
  throw new Error('Electron HostBridge is not part of P3');
}
