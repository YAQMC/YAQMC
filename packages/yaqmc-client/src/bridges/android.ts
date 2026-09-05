import type {
  HostBridge,
  HostCapabilities,
  HostNativeShareRequest,
  HostShellBridge,
  HostClipboardBridge,
  HostDialogBridge,
  WindowRole,
} from '../bridge';
import type { MethodName, MethodResult } from '../protocol/methods';
import type { InvokeArgs } from '../bridge';
import { CHANNEL_APP_OPEN_CATALOG_SONG } from '../protocol/events';

/** Narrow API exposed by the Android WebView/JNI adapter. */
export interface AndroidRendererApi {
  invoke(method: string, params?: unknown): Promise<unknown>;
  on(channel: string, callback: (payload: unknown) => void): () => void;
  share?(request: HostNativeShareRequest): Promise<void>;
  clipboard?: HostClipboardBridge;
  shell?: HostShellBridge;
  dialog?: HostDialogBridge;
  capabilities?: Partial<HostCapabilities>;
  platform?: 'android';
  kind?: 'android';
}

interface CapacitorListenerHandle {
  remove(): Promise<void>;
}

interface CapacitorYaqmcPlugin {
  invoke(options: { method: string; params?: unknown }): Promise<{ value: unknown }>;
  shell(options: { url: string }): Promise<void>;
  clipboardSet(options: { text: string }): Promise<void>;
  nativeShare(request: HostNativeShareRequest): Promise<void>;
  pickBackgroundImage(): Promise<{ path?: string | null }>;
  addListener(
    event: 'coreEvent' | 'deepLink' | 'updateAvailable',
    listener: (payload: Record<string, unknown>) => void,
  ): Promise<CapacitorListenerHandle>;
}

interface CapacitorRuntime {
  getPlatform?(): string;
  isNativePlatform?(): boolean;
  convertFileSrc?(path: string): string;
  Plugins?: {
    YaqmcNative?: CapacitorYaqmcPlugin;
  };
}

function parseJsonPayload(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function adaptAndroidFileValue(
  capacitor: CapacitorRuntime,
  method: string,
  value: unknown,
): unknown {
  if (method !== 'preferences_set_background_from' && method !== 'appearance_background_load') {
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const nativePath = record.nativePath;
  if (typeof nativePath !== 'string' || nativePath.length === 0) return value;
  const convert = capacitor.convertFileSrc;
  if (!convert) throw new Error('Android file URL adapter is unavailable');
  const adapted: Record<string, unknown> = { ...record, dataUri: convert(nativePath) };
  delete adapted.nativePath;
  return adapted;
}

/**
 * Adapt Capacitor's generated plugin proxy to the platform-neutral bridge.
 * A single native subscription per event type is multiplexed by protocol channel.
 */
export function readCapacitorAndroidApi(
  root: typeof globalThis = globalThis,
): AndroidRendererApi | undefined {
  const capacitor = Reflect.get(root, 'Capacitor') as CapacitorRuntime | undefined;
  const plugin = capacitor?.Plugins?.YaqmcNative;
  if (
    !plugin ||
    capacitor?.getPlatform?.() !== 'android' ||
    capacitor?.isNativePlatform?.() === false
  ) {
    return undefined;
  }

  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  let pendingDeepLink: unknown;
  const emit = (channel: string, payload: unknown): boolean => {
    const channelHandlers = handlers.get(channel);
    if (!channelHandlers?.size) return false;
    for (const handler of channelHandlers) handler(payload);
    return true;
  };
  const subscriptions = [
    plugin.addListener('coreEvent', (event) => {
      const channel = typeof event.channel === 'string' ? event.channel : '';
      if (channel) emit(channel, parseJsonPayload(event.json));
    }),
    plugin.addListener('deepLink', (event) => {
      const payload = {
        providerId: event.providerId,
        entityId: event.entityId,
      };
      // Capacitor may deliver a retained cold-start event before React mounts
      // its route listener. Match the native inbox by retaining only the newest target.
      if (!emit(CHANNEL_APP_OPEN_CATALOG_SONG, payload)) pendingDeepLink = payload;
    }),
    plugin.addListener('updateAvailable', (event) => {
      emit('host://update', event);
    }),
  ];
  void Promise.allSettled(subscriptions);

  return {
    kind: 'android',
    platform: 'android',
    invoke: async (method, params) => {
      const response = await plugin.invoke({
        method,
        ...(params === undefined ? {} : { params }),
      });
      return adaptAndroidFileValue(capacitor, method, response.value);
    },
    on: (channel, callback) => {
      const channelHandlers = handlers.get(channel) ?? new Set();
      channelHandlers.add(callback);
      handlers.set(channel, channelHandlers);
      if (channel === CHANNEL_APP_OPEN_CATALOG_SONG && pendingDeepLink !== undefined) {
        const payload = pendingDeepLink;
        pendingDeepLink = undefined;
        callback(payload);
      }
      return () => {
        channelHandlers.delete(callback);
        if (channelHandlers.size === 0) handlers.delete(channel);
      };
    },
    share: (request) => plugin.nativeShare(request),
    shell: {
      openExternal: (url) => plugin.shell({ url }),
    },
    clipboard: {
      writeText: (text) => plugin.clipboardSet({ text }),
    },
    dialog: {
      pickSave: async () => null,
      pickFile: async ({ kind }) => {
        if (kind !== 'background-image') return null;
        const result = await plugin.pickBackgroundImage();
        return typeof result.path === 'string' && result.path.trim() ? result.path : null;
      },
    },
  };
}

function invokeThrough<M extends MethodName>(
  api: AndroidRendererApi,
  method: M,
  params: InvokeArgs<M>,
): Promise<MethodResult[M]> {
  return (params.length === 0 ? api.invoke(method) : api.invoke(method, params[0])) as Promise<
    MethodResult[M]
  >;
}

function androidShell(api: AndroidRendererApi): HostShellBridge {
  return (
    api.shell ?? {
      openExternal: (url) => api.invoke('shell.openExternal', { url }).then(() => undefined),
    }
  );
}

export function createAndroidBridge(
  api: AndroidRendererApi,
  windowRole: WindowRole = 'main',
): HostBridge {
  return {
    kind: 'android',
    windowRole,
    capabilities: {
      windowControls: false,
      lyricsSurfaces: false,
      plugins: false,
      localApi: false,
      fileExport: false,
      fileImport: true,
      nativeShare: true,
      deepLinks: true,
      updateMode: 'notify',
      ...api.capabilities,
    },
    shell: androidShell(api),
    clipboard: api.clipboard,
    dialog: api.dialog,
    share: {
      share: (request) =>
        api.share ? api.share(request) : api.invoke('nativeShare', request).then(() => undefined),
    },
    invoke: (method, ...params) => invokeThrough(api, method, params),
    listen: (channel, handler) => api.on(channel, handler as (payload: unknown) => void),
  } as HostBridge;
}
