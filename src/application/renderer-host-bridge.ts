import {
  createElectronBridge,
  createFakeBridge,
  type ElectronRendererApi,
  type HostBridge,
  type WindowRole,
} from '@yaqmc/client';

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

function readRendererApi(): ElectronRendererApi | undefined {
  const candidate = Reflect.get(window, 'yaqmc');
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    typeof (candidate as ElectronRendererApi).invoke === 'function' &&
    typeof (candidate as ElectronRendererApi).on === 'function'
  ) {
    return candidate as ElectronRendererApi;
  }
  return undefined;
}

export function selectHostBridge(search: string = window.location.search): HostBridge {
  const windowRole = windowRoleFromSearch(search);
  const parameters = new URLSearchParams(search);
  if (parameters.get('provider') === 'fake') {
    return createFakeBridge({ windowRole });
  }
  const api = readRendererApi();
  return api ? createElectronBridge(api, windowRole) : createFakeBridge({ windowRole });
}
