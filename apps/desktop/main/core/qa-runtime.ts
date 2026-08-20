import os from 'node:os';
import path from 'node:path';

/** FACT `src-tauri/tauri.conf.json` identifier. Matches `scripts/qa-runtime.mjs`. */
export const APP_IDENTIFIER = 'org.yaqmc.desktop';
export const QA_SANDBOX_DIR_NAME = 'yaqmc-qa';
export const QA_ROOT_ENV = 'YAQMC_QA_ROOT';
export const QA_MODE_ENV = 'YAQMC_QA_MODE';

export const QA_LAUNCH_FLAGS = [
  QA_MODE_ENV,
  'YAQMC_ELECTRON_E2E',
  'YAQMC_DESKTOP_SMOKE',
  'YAQMC_UI_PERF_DIAG',
] as const;

export type QaSandboxPaths = {
  root: string;
  electronUserData: string;
  coreData: string;
  cache: string;
  plugins: string;
  logs: string;
  diagnostics: string;
  tmp: string;
  config: string;
  appData: string;
  localAppData: string;
  corePaths: {
    dataDir: string;
    cacheDir: string;
    logDir: string;
    configDir: string;
  };
};

export type ProductionRootLookup = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
};

export function isQaLaunch(env: NodeJS.ProcessEnv = process.env): boolean {
  return QA_LAUNCH_FLAGS.some((key) => env[key] === '1');
}

function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return (platform === 'win32' ? path.win32 : path.posix).join(...parts);
}

function homedirFrom(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, fallback?: string): string {
  if (platform === 'win32') {
    return env.USERPROFILE ?? env.HOME ?? fallback ?? os.homedir() ?? '';
  }
  return env.HOME ?? env.USERPROFILE ?? fallback ?? os.homedir() ?? '';
}

export function resolveProductionCoreRoots(lookup: ProductionRootLookup = {}): {
  dataDir: string;
  cacheDir: string;
  logDir: string;
  configDir: string;
  electronUserDataUnpackaged: string;
  electronUserDataPackaged: string;
} {
  const platform = lookup.platform ?? process.platform;
  const env = lookup.env ?? process.env;
  const home = lookup.homedir ?? homedirFrom(env, platform);
  if (platform === 'win32') {
    const appData = joinFor('win32', home, 'AppData', 'Roaming');
    const localAppData = joinFor('win32', home, 'AppData', 'Local');
    const dataDir = joinFor('win32', appData, APP_IDENTIFIER);
    const cacheDir = joinFor('win32', localAppData, APP_IDENTIFIER);
    return {
      dataDir,
      cacheDir,
      logDir: joinFor('win32', cacheDir, 'logs'),
      configDir: dataDir,
      electronUserDataUnpackaged: joinFor('win32', appData, '@yaqmc', 'desktop'),
      electronUserDataPackaged: joinFor('win32', appData, 'YAQMC'),
    };
  }
  const dataHome = joinFor('posix', home, '.local', 'share');
  const cacheHome = joinFor('posix', home, '.cache');
  const configHome = joinFor('posix', home, '.config');
  const dataDir = joinFor('posix', dataHome, APP_IDENTIFIER);
  return {
    dataDir,
    cacheDir: joinFor('posix', cacheHome, APP_IDENTIFIER),
    logDir: joinFor('posix', dataDir, 'logs'),
    configDir: joinFor('posix', configHome, APP_IDENTIFIER),
    electronUserDataUnpackaged: joinFor('posix', configHome, '@yaqmc', 'desktop'),
    electronUserDataPackaged: joinFor('posix', configHome, 'YAQMC'),
  };
}

export function normalizeFsPath(value: string): string {
  return path.resolve(value).replaceAll('\\', '/').replace(/\/+$/u, '').toLowerCase();
}

export function isSameOrInsidePath(inner: string, outer: string): boolean {
  const left = normalizeFsPath(inner);
  const right = normalizeFsPath(outer);
  return left === right || left.startsWith(`${right}/`);
}

export function describeSandbox(root: string): QaSandboxPaths {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    electronUserData: path.join(resolved, 'electron-user-data'),
    coreData: path.join(resolved, 'core-data'),
    cache: path.join(resolved, 'cache'),
    plugins: path.join(resolved, 'plugins'),
    logs: path.join(resolved, 'logs'),
    diagnostics: path.join(resolved, 'diagnostics'),
    tmp: path.join(resolved, 'tmp'),
    config: path.join(resolved, 'config'),
    appData: path.join(resolved, 'appdata'),
    localAppData: path.join(resolved, 'localappdata'),
    corePaths: {
      dataDir: path.join(resolved, 'core-data'),
      cacheDir: path.join(resolved, 'cache'),
      logDir: path.join(resolved, 'logs'),
      configDir: path.join(resolved, 'config'),
    },
  };
}

export function productionRootsList(lookup: ProductionRootLookup = {}): string[] {
  const roots = resolveProductionCoreRoots(lookup);
  return [
    roots.dataDir,
    roots.cacheDir,
    roots.logDir,
    roots.configDir,
    roots.electronUserDataUnpackaged,
    roots.electronUserDataPackaged,
  ];
}

export function assertSandboxNotProduction(
  sandboxOrRoot: string | QaSandboxPaths,
  lookup: ProductionRootLookup = {},
): QaSandboxPaths {
  const sandbox = typeof sandboxOrRoot === 'string' ? describeSandbox(sandboxOrRoot) : sandboxOrRoot;
  const env = lookup.env ?? process.env;
  const roots = productionRootsList({ ...lookup, env });
  const watched = [
    sandbox.root,
    sandbox.coreData,
    sandbox.cache,
    sandbox.logs,
    sandbox.config,
    sandbox.electronUserData,
    sandbox.appData,
    sandbox.localAppData,
  ];
  for (const writable of watched) {
    for (const forbidden of roots) {
      if (isSameOrInsidePath(writable, forbidden) || isSameOrInsidePath(forbidden, writable)) {
        throw new Error(
          `QA sandbox refused: writable root ${writable} overlaps production ${forbidden}`,
        );
      }
    }
  }
  return sandbox;
}

export function requireQaSandboxFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  lookup: ProductionRootLookup = {},
): QaSandboxPaths | null {
  if (!isQaLaunch(env)) {
    return null;
  }
  const root = env[QA_ROOT_ENV];
  if (!root?.trim()) {
    throw new Error('QA/perf/e2e refused: YAQMC_QA_ROOT is required before starting Core');
  }
  return assertSandboxNotProduction(root, {
    platform: lookup.platform,
    homedir: lookup.homedir ?? env.USERPROFILE ?? env.HOME,
    env,
  });
}

export function coreTempEnv(sandbox: QaSandboxPaths): NodeJS.ProcessEnv {
  return {
    TEMP: sandbox.tmp,
    TMP: sandbox.tmp,
    TMPDIR: sandbox.tmp,
    YAQMC_CREDENTIAL_DIR: path.join(sandbox.coreData, 'credentials'),
    YAQMC_PLUGIN_FALLBACK_DIR: sandbox.plugins,
    YAQMC_LOG_FALLBACK_DIR: path.join(sandbox.logs, 'fallback'),
    YAQMC_DOWNLOAD_DIR: path.join(sandbox.tmp, 'downloads'),
  };
}
