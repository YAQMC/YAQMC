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

export function selectHostBridge(
  search: string = window.location.search,
  buildType: string = __YAQMC_BUILD_TYPE__,
): HostBridge {
  const windowRole = windowRoleFromSearch(search);
  const parameters = new URLSearchParams(search);
  const api = readRendererApi();
  if (parameters.get('provider') === 'fake') {
    const bridge = createFakeBridge({ windowRole });
    // Fake catalog/Core calls must stay offline, while safe one-way host
    // capabilities still exercise the real Electron boundary in QA.
    return api ? { ...bridge, clipboard: createElectronBridge(api, windowRole).clipboard } : bridge;
  }
  if (api) return createElectronBridge(api, windowRole);
  if (buildType === 'release') {
    throw new Error('Electron preload bridge is unavailable in the release renderer');
  }
  return createFakeBridge({ windowRole });
}
