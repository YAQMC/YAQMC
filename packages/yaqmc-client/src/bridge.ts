export type HostKind = 'electron' | 'tauri' | 'fake';

export type WindowRole =
  'main' | 'lyrics-desktop' | 'lyrics-island' | 'unlock-desktop' | 'unlock-island';

export interface HostBridge {
  invoke(method: string, params?: unknown): Promise<unknown>;
  listen(channel: string, handler: (payload: unknown) => void): () => void;
  readonly kind: HostKind;
  readonly windowRole: WindowRole;
}
