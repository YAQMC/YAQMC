import type { ChannelName, ChannelPayload } from './protocol/events';
import type { MethodName, MethodParams, MethodResult } from './protocol/methods';

export type HostKind = 'electron' | 'tauri' | 'fake';

export type WindowRole =
  'main' | 'lyrics-desktop' | 'lyrics-island' | 'unlock-desktop' | 'unlock-island';

export type InvokeArgs<M extends MethodName> = MethodParams[M] extends void
  ? []
  : [MethodParams[M]];

export interface HostBridge {
  invoke<M extends MethodName>(method: M, ...params: InvokeArgs<M>): Promise<MethodResult[M]>;
  listen<C extends ChannelName>(
    channel: C,
    handler: (payload: ChannelPayload[C]) => void,
  ): () => void;
  readonly kind: HostKind;
  readonly windowRole: WindowRole;
}
