import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  createFakeBridge,
  type ChannelPayload,
  type HostBridge,
  type HostDialogBridge,
  type HostShellBridge,
  type HostWindowBridge,
  type InvokeArgs,
  type MethodName,
  type MethodResult,
  type WindowRole,
} from '@yaqmc/client';

export interface RendererYaqmc {
  invoke(method: string, params?: unknown): Promise<unknown>;
  on(channel: string, cb: (payload: unknown) => void): () => void;
  windowRole?: string;
  window?: HostWindowBridge;
  shell?: HostShellBridge;
}

export function windowRoleFromSearch(search: string = window.location.search): WindowRole {
  const parameters = new URLSearchParams(search);
  const unlockSurface = parameters.get('unlockSurface');
  if (unlockSurface === 'desktop' || unlockSurface === 'island') {
    return unlockSurface === 'desktop' ? 'unlock-desktop' : 'unlock-island';
  }
  const surface = parameters.get('surface');
  if (surface === 'desktop' || surface === 'island') {
    return surface === 'desktop' ? 'lyrics-desktop' : 'lyrics-island';
  }
  return 'main';
}

function invokeWindow(yaqmc: RendererYaqmc): HostWindowBridge {
  if (yaqmc.window) {
    return yaqmc.window;
  }
  return {
    minimize: () => yaqmc.invoke('window.minimize').then(() => undefined),
    toggleMaximize: () => yaqmc.invoke('window.toggleMaximize').then(() => undefined),
    close: () => yaqmc.invoke('window.close').then(() => undefined),
    setFullscreen: (enabled) =>
      yaqmc.invoke('window.setFullscreen', { enabled }).then(() => undefined),
  };
}

function invokeShell(yaqmc: RendererYaqmc): HostShellBridge {
  if (yaqmc.shell) {
    return yaqmc.shell;
  }
  return {
    openExternal: (url) => yaqmc.invoke('shell.openExternal', { url }).then(() => undefined),
  };
}

function unusedDialog(): HostDialogBridge {
  return {
    pickSave: async () => null,
  };
}

function readRendererYaqmc(): RendererYaqmc | undefined {
  const candidate = Reflect.get(window, 'yaqmc');
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    typeof (candidate as RendererYaqmc).invoke === 'function' &&
    typeof (candidate as RendererYaqmc).on === 'function'
  ) {
    return candidate as RendererYaqmc;
  }
  return undefined;
}

function invokeThrough<M extends MethodName>(
  call: (method: string, params?: unknown) => Promise<unknown>,
  method: M,
  params: InvokeArgs<M>,
): Promise<MethodResult[M]> {
  if (params.length === 0) {
    return call(method) as Promise<MethodResult[M]>;
  }
  return call(method, params[0]) as Promise<MethodResult[M]>;
}

function createElectronRendererBridge(yaqmc: RendererYaqmc, windowRole: WindowRole): HostBridge {
  return {
    kind: 'electron',
    windowRole,
    window: invokeWindow(yaqmc),
    shell: invokeShell(yaqmc),
    dialog: {
      pickSave: (opts) =>
        yaqmc.invoke('dialog.pickSave', { defaultPath: opts?.defaultPath }) as Promise<string | null>,
    },
    invoke: (method, ...params) => invokeThrough(yaqmc.invoke.bind(yaqmc), method, params),
    listen: (channel, handler) => yaqmc.on(channel, handler as (payload: unknown) => void),
  };
}

export function createTauriHostBridge(windowRole: WindowRole = windowRoleFromSearch()): HostBridge {
  return {
    kind: 'tauri',
    windowRole,
    window: {
      minimize: () => getCurrentWindow().minimize(),
      toggleMaximize: () => getCurrentWindow().toggleMaximize(),
      close: () => getCurrentWindow().close(),
      setFullscreen: (enabled) => getCurrentWindow().setFullscreen(enabled),
    },
    shell: {
      openExternal: (url) => openUrl(url),
    },
    dialog: unusedDialog(),
    invoke: (method, ...params) =>
      invokeThrough(
        (name, args) =>
          args === undefined ? invoke(name) : invoke(name, args as Record<string, unknown>),
        method,
        params,
      ),
    listen: (channel, handler) => {
      let unlisten: (() => void) | undefined;
      let cancelled = false;
      void listen(channel, (event) => {
        handler(event.payload as ChannelPayload[typeof channel]);
      })
        .then((stop) => {
          if (cancelled) {
            stop();
            return;
          }
          unlisten = stop;
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
        unlisten?.();
      };
    },
  };
}

export function selectHostBridge(search: string = window.location.search): HostBridge {
  const windowRole = windowRoleFromSearch(search);
  const parameters = new URLSearchParams(search);
  if (parameters.get('provider') === 'fake') {
    return createFakeBridge({ windowRole });
  }
  const yaqmc = readRendererYaqmc();
  if (yaqmc) {
    return createElectronRendererBridge(yaqmc, windowRole);
  }
  if (isTauri()) {
    return createTauriHostBridge(windowRole);
  }
  return createFakeBridge({ windowRole });
}
