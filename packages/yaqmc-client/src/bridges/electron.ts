import type {
  HostBridge,
  HostShellBridge,
  HostWindowBridge,
  InvokeArgs,
  WindowRole,
} from '../bridge';
import type { MethodName, MethodResult } from '../protocol/methods';

export interface ElectronRendererApi {
  invoke(method: string, params?: unknown): Promise<unknown>;
  on(channel: string, callback: (payload: unknown) => void): () => void;
  window?: HostWindowBridge;
  shell?: HostShellBridge;
}

function invokeWindow(api: ElectronRendererApi): HostWindowBridge {
  if (api.window) return api.window;
  return {
    minimize: () => api.invoke('window.minimize').then(() => undefined),
    toggleMaximize: () => api.invoke('window.toggleMaximize').then(() => undefined),
    close: () => api.invoke('window.close').then(() => undefined),
    setFullscreen: (enabled) =>
      api.invoke('window.setFullscreen', { enabled }).then(() => undefined),
  };
}

function invokeShell(api: ElectronRendererApi): HostShellBridge {
  if (api.shell) return api.shell;
  return {
    openExternal: (url) => api.invoke('shell.openExternal', { url }).then(() => undefined),
  };
}

function invokeThrough<M extends MethodName>(
  call: (method: string, params?: unknown) => Promise<unknown>,
  method: M,
  params: InvokeArgs<M>,
): Promise<MethodResult[M]> {
  return (params.length === 0 ? call(method) : call(method, params[0])) as Promise<MethodResult[M]>;
}

export function createElectronBridge(
  api: ElectronRendererApi,
  windowRole: WindowRole = 'main',
): HostBridge {
  return {
    kind: 'electron',
    windowRole,
    window: invokeWindow(api),
    shell: invokeShell(api),
    dialog: {
      pickSave: (options) =>
        api.invoke('dialog.pickSave', {
          ...(options?.kind === undefined ? {} : { kind: options.kind }),
          ...(options?.defaultPath === undefined ? {} : { defaultPath: options.defaultPath }),
        }) as Promise<string | null>,
      pickFile: (options) => api.invoke('dialog.pickFile', options) as Promise<string | null>,
    },
    invoke: (method, ...params) => invokeThrough(api.invoke.bind(api), method, params),
    listen: (channel, handler) => api.on(channel, handler as (payload: unknown) => void),
  };
}
