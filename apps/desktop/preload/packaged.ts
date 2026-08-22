export type PreloadHostInfo = {
  electron: string;
  platform: 'win32' | 'linux';
  coreProtocol: 1;
  packaged: boolean;
};

/**
 * Mirrors Electron's `app.isPackaged` without importing `app` (sandbox preload
 * cannot). Empty `execPath` fails closed so unpackaged/unknown hosts do not
 * advertise a packaged renderer.
 */
export function hostIsPackaged(execPath: string, platform: string): boolean {
  const base = execPath.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? '';
  if (!base) {
    return false;
  }
  if (platform === 'win32') {
    return base !== 'electron.exe';
  }
  return base !== 'electron';
}

export function createPreloadHostInfo(
  versionsElectron: string | undefined,
  platform: string,
  execPath: string,
): PreloadHostInfo {
  return {
    electron: versionsElectron ?? '',
    platform: platform === 'linux' ? 'linux' : 'win32',
    coreProtocol: 1,
    packaged: hostIsPackaged(execPath, platform),
  };
}
