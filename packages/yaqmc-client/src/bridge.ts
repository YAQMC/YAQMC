import type { ChannelName, ChannelPayload } from './protocol/events';
import type { MethodName, MethodParams, MethodResult } from './protocol/methods';

export type HostKind = 'electron' | 'android' | 'fake';

/** Host-owned features. A renderer must use these gates instead of inferring
 * desktop support from the fact that a native bridge exists. */
export interface HostCapabilities {
  windowControls: boolean;
  lyricsSurfaces: boolean;
  plugins: boolean;
  localApi: boolean;
  fileExport: boolean;
  fileImport: boolean;
  nativeShare: boolean;
  deepLinks: boolean;
  updateMode: 'install' | 'notify' | 'none';
}

export const DESKTOP_HOST_CAPABILITIES: Readonly<HostCapabilities> = {
  windowControls: true,
  lyricsSurfaces: true,
  plugins: true,
  localApi: true,
  fileExport: true,
  fileImport: true,
  nativeShare: false,
  deepLinks: true,
  updateMode: 'install',
};

export const ANDROID_HOST_CAPABILITIES: Readonly<HostCapabilities> = {
  windowControls: false,
  lyricsSurfaces: false,
  plugins: false,
  localApi: false,
  fileExport: false,
  fileImport: true,
  nativeShare: true,
  deepLinks: true,
  updateMode: 'notify',
};

export const FAKE_HOST_CAPABILITIES: Readonly<HostCapabilities> = {
  windowControls: false,
  lyricsSurfaces: true,
  plugins: false,
  localApi: true,
  fileExport: true,
  fileImport: false,
  nativeShare: false,
  deepLinks: true,
  updateMode: 'none',
};

export function defaultHostCapabilities(kind: HostKind): Readonly<HostCapabilities> {
  switch (kind) {
    case 'electron':
      return DESKTOP_HOST_CAPABILITIES;
    case 'android':
      return ANDROID_HOST_CAPABILITIES;
    case 'fake':
      return FAKE_HOST_CAPABILITIES;
  }
}

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

export interface HostShareRequest {
  text: string;
  title?: string;
  url?: string;
}

export interface HostShareBridge {
  share(request: HostShareRequest): Promise<void>;
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
  readonly capabilities?: HostCapabilities;
  /** Android bridges intentionally omit this at runtime. */
  readonly window?: HostWindowBridge;
  readonly shell: HostShellBridge;
  readonly clipboard?: HostClipboardBridge;
  readonly dialog?: HostDialogBridge;
  readonly share?: HostShareBridge;
}

/** @deprecated Use HostShareRequest. */
export type HostNativeShareRequest = HostShareRequest;
/** @deprecated Use HostShareBridge. */
export type HostNativeShareBridge = HostShareBridge;
