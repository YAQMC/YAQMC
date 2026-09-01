import type { ChannelName, ChannelPayload } from './protocol/events';
import type { MethodName, MethodParams, MethodResult } from './protocol/methods';

export type HostKind = 'electron' | 'fake';

export type WindowRole =
  'main' | 'lyrics-desktop' | 'lyrics-island' | 'unlock-desktop' | 'unlock-island';

export type InvokeArgs<M extends MethodName> = MethodParams[M] extends void
  ? []
  : [MethodParams[M]];

export interface HostWindowBridge {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  setFullscreen(enabled: boolean): Promise<void>;
}

export interface HostShellBridge {
  openExternal(url: string): Promise<void>;
}

export interface HostClipboardBridge {
  writeText(text: string): Promise<void>;
}

export type HostOpenFileKind = 'background-image' | 'plugin-package';
export type HostSaveFileKind = 'diagnostics-zip' | 'statistics-json' | 'statistics-csv';

/** Extra host IPC (`dialog.pickSave` / `dialog.pickFile`); not inventory MethodNames. */
export interface HostDialogBridge {
  pickSave(opts?: { kind?: HostSaveFileKind; defaultPath?: string }): Promise<string | null>;
  pickFile(opts: { kind: HostOpenFileKind }): Promise<string | null>;
}

export interface HostBridge {
  invoke<M extends MethodName>(method: M, ...params: InvokeArgs<M>): Promise<MethodResult[M]>;
  listen<C extends ChannelName>(
    channel: C,
    handler: (payload: ChannelPayload[C]) => void,
  ): () => void;
  readonly kind: HostKind;
  readonly windowRole: WindowRole;
  readonly window: HostWindowBridge;
  readonly shell: HostShellBridge;
  readonly clipboard?: HostClipboardBridge;
  readonly dialog?: HostDialogBridge;
}
