import os from 'node:os';
import path from 'node:path';

/** FACT `src-tauri/tauri.conf.json` identifier. Electron `userData` is not used for core data. */
export const APP_IDENTIFIER = 'org.yaqmc.desktop';
export const LIBRARY_SQLITE = 'library.sqlite3';
export const LOCAL_API_CONFIG = 'local-api.json';

export type CorePathLookup = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
};

export type CoreDataPaths = {
  dataDir: string;
  cacheDir: string;
  logDir: string;
  configDir: string;
};

/**
 * BASE-04 / §18.1 Tauri-parity directories for yaqmc-core.
 * Windows: `%APPDATA%` / `%LOCALAPPDATA%`. Linux: XDG with `~/.local/share` etc. fallbacks.
 */
export function resolveCorePaths(lookup: CorePathLookup = {}): CoreDataPaths {
  const platform = lookup.platform ?? process.platform;
  const env = lookup.env ?? process.env;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const home =
    lookup.homedir ??
    env.HOME ??
    env.USERPROFILE ??
    os.homedir() ??
    (platform === 'win32' ? 'C:\\Users\\Default' : '/home');

  if (platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const dataDir = join(appData, APP_IDENTIFIER);
    const cacheDir = join(localAppData, APP_IDENTIFIER);
    return {
      dataDir,
      cacheDir,
      logDir: join(cacheDir, 'logs'),
      configDir: dataDir,
    };
  }

  const dataHome = env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  const cacheHome = env.XDG_CACHE_HOME ?? join(home, '.cache');
  const configHome = env.XDG_CONFIG_HOME ?? join(home, '.config');
  const dataDir = join(dataHome, APP_IDENTIFIER);
  return {
    dataDir,
    cacheDir: join(cacheHome, APP_IDENTIFIER),
    logDir: join(dataDir, 'logs'),
    configDir: join(configHome, APP_IDENTIFIER),
  };
}

export function localApiConfigPath(
  paths: CoreDataPaths,
  platform: NodeJS.Platform = process.platform,
): string {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(paths.configDir, LOCAL_API_CONFIG);
}

export function librarySqlitePath(
  paths: CoreDataPaths,
  platform: NodeJS.Platform = process.platform,
): string {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(paths.dataDir, LIBRARY_SQLITE);
}
