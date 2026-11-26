import type { ComponentResult, ComponentStatus } from 'electron';

export type ProtectedAudioComponents = {
  readonly WIDEVINE_CDM_ID: string;
  whenReady(required?: string[]): Promise<ComponentResult[]>;
  status(): Record<string, ComponentStatus>;
};

export type ProtectedAudioRuntimeState = {
  ready: boolean;
  componentStatus: string | null;
  version: string | null;
};

/**
 * Castlabs ECS installs Widevine through its component updater. A protected
 * window must wait for that installation before Chromium starts an EME session.
 */
export async function prepareProtectedAudioRuntime(
  platform: NodeJS.Platform,
  components: ProtectedAudioComponents,
): Promise<ProtectedAudioRuntimeState> {
  if (platform !== 'win32') {
    return { ready: true, componentStatus: null, version: null };
  }
  try {
    await components.whenReady([components.WIDEVINE_CDM_ID]);
  } catch {
    const failed = components.status()[components.WIDEVINE_CDM_ID];
    return {
      ready: false,
      componentStatus: failed?.status ?? 'installation-failed',
      version: failed?.version ?? null,
    };
  }
  const installed = components.status()[components.WIDEVINE_CDM_ID];
  return {
    ready: true,
    componentStatus: installed?.status ?? 'ready',
    version: installed?.version ?? null,
  };
}
