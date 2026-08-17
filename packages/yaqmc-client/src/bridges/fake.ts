import type { HostBridge } from '../bridge';

export function createFakeBridge(): HostBridge {
  throw new Error('Fake HostBridge lands in CLIENT-06');
}
