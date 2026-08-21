/**
 * Canonical QA / perf / diagnostic sandbox.
 *
 * Launchers that can mutate Core or Electron state must create a unique root
 * under `<tmpdir>/yaqmc-qa/<run-id>/` and pass `YAQMC_QA_ROOT`. Electron Main
 * fail-closes if a QA flag is set and the writable root resolves to the
 * maintainer production profile.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_IDENTIFIER = 'org.yaqmc.desktop';
export const QA_SANDBOX_DIR_NAME = 'yaqmc-qa';
export const QA_SANDBOX_MARKER = '.yaqmc-qa-sandbox';
export const QA_ROOT_ENV = 'YAQMC_QA_ROOT';
export const QA_MODE_ENV = 'YAQMC_QA_MODE';
export const PRODUCTION_ATTACH_ENV = 'YAQMC_ALLOW_PRODUCTION_ATTACH';

export const QA_LAUNCH_FLAGS = Object.freeze([
  QA_MODE_ENV,
  'YAQMC_ELECTRON_E2E',
  'YAQMC_DESKTOP_SMOKE',
  'YAQMC_UI_PERF_DIAG',
]);

const STRIP_QA_KEYS = Object.freeze([
  ...QA_LAUNCH_FLAGS,
  QA_ROOT_ENV,
  'YAQMC_E2E_CORE',
  'YAQMC_E2E_NATIVE',
  'YAQMC_E2E_TRAY',
  'YAQMC_UI_PERF_DIAG_QUIT',
  'YAQMC_UI_PERF_DIAG_OUT',
  'YAQMC_UI_PERF_DIAG_VARIANTS',
  'YAQMC_UI_PERF_DIAG_TIMEOUT_MS',
  'YAQMC_WINDOWS_OCCLUSION',
  'YAQMC_CREDENTIAL_DIR',
  'YAQMC_PLUGIN_FALLBACK_DIR',
  'YAQMC_LOG_FALLBACK_DIR',
  'YAQMC_DOWNLOAD_DIR',
]);

export function isQaLaunch(env = process.env) {
  return QA_LAUNCH_FLAGS.some((key) => env[key] === '1');
}

export function productionAttachAllowed(env = process.env) {
  return env[PRODUCTION_ATTACH_ENV] === '1';
}

export function assertProductionAttachAllowed(env = process.env, what = 'production attach') {
  if (productionAttachAllowed(env)) {
    return;
  }
  throw new Error(
    `${what} refused: set ${PRODUCTION_ATTACH_ENV}=1 for an explicit read of the live session`,
  );
}

function joinFor(platform, ...parts) {
  // path.win32.join('/tmp/x', 'AppData') => '\tmp\x\AppData', which is cwd-relative
  // on POSIX and must never be mkdir'd. Keep the Windows layout, but join with posix
  // when the homedir is already a POSIX absolute path.
  if (
    platform === 'win32' &&
    process.platform !== 'win32' &&
    String(parts[0] ?? '').startsWith('/')
  ) {
    return path.posix.join(...parts.map((part) => String(part).replaceAll('\\', '/')));
  }
  return (platform === 'win32' ? path.win32 : path.posix).join(...parts);
}

function homedirFrom(env, platform, fallback) {
  if (platform === 'win32') {
    return env.USERPROFILE || env.HOME || fallback || os.homedir() || '';
  }
  return env.HOME || env.USERPROFILE || fallback || os.homedir() || '';
}

export function resolveProductionCoreRoots(lookup = {}) {
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

export function normalizeFsPath(value) {
  return path.resolve(value).replaceAll('\\', '/').replace(/\/+$/u, '').toLowerCase();
}

export function isSameOrInsidePath(inner, outer) {
  const left = normalizeFsPath(inner);
  const right = normalizeFsPath(outer);
  return left === right || left.startsWith(`${right}/`);
}

export function describeSandbox(root) {
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

export function productionRootsList(lookup = {}) {
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

export function assertSandboxNotProduction(sandboxOrRoot, lookup = {}) {
  const sandbox =
    typeof sandboxOrRoot === 'string' ? describeSandbox(sandboxOrRoot) : sandboxOrRoot;
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

export function assertQaRootNotProduction(root, lookup = {}) {
  if (!root || !String(root).trim()) {
    throw new Error('QA/perf/e2e refused: YAQMC_QA_ROOT is required before starting Core');
  }
  return assertSandboxNotProduction(root, lookup);
}

function newRunId() {
  return `${Date.now().toString(36)}-${process.pid}-${randomBytes(4).toString('hex')}`;
}

export function createQaSandbox(options = {}) {
  const tmpdir = options.tmpdir ?? os.tmpdir();
  const runId = options.runId ?? newRunId();
  const root = path.join(tmpdir, QA_SANDBOX_DIR_NAME, runId);
  const sandbox = describeSandbox(root);
  assertSandboxNotProduction(sandbox, {
    env: options.env ?? process.env,
    platform: options.platform,
    homedir: options.homedir,
  });
  for (const dir of [
    sandbox.root,
    sandbox.electronUserData,
    sandbox.coreData,
    sandbox.cache,
    sandbox.plugins,
    sandbox.logs,
    sandbox.diagnostics,
    sandbox.tmp,
    sandbox.config,
    sandbox.appData,
    sandbox.localAppData,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    path.join(sandbox.root, QA_SANDBOX_MARKER),
    `${JSON.stringify({
      v: 1,
      purpose: options.purpose ?? 'qa',
      runId,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    })}\n`,
    'utf8',
  );
  return sandbox;
}

export function readSandboxMarker(root) {
  const file = path.join(root, QA_SANDBOX_MARKER);
  if (!existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function assertIsQaSandbox(root) {
  const resolved = path.resolve(root);
  if (path.basename(path.dirname(resolved)) !== QA_SANDBOX_DIR_NAME) {
    throw new Error(`cleanup refused: ${resolved} is not under ${QA_SANDBOX_DIR_NAME}`);
  }
  if (!readSandboxMarker(resolved)) {
    throw new Error(`cleanup refused: ${resolved} has no ${QA_SANDBOX_MARKER} marker`);
  }
  return describeSandbox(resolved);
}

export function cleanupQaSandbox(root, options = {}) {
  const sandbox = assertIsQaSandbox(root);
  assertSandboxNotProduction(sandbox, {
    env: options.env ?? process.env,
    platform: options.platform,
    homedir: options.homedir,
  });
  rmSync(sandbox.root, { recursive: true, force: true });
}

export function stripQaLaunchFlags(env = process.env) {
  const next = { ...env };
  for (const key of STRIP_QA_KEYS) {
    delete next[key];
  }
  return next;
}

export function coreTempEnv(sandbox) {
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

export function qaElectronEnv(parentEnv, sandbox, extras = {}) {
  assertSandboxNotProduction(sandbox, {
    env: parentEnv,
    homedir: parentEnv?.USERPROFILE || parentEnv?.HOME,
  });
  const env = { ...parentEnv, ...coreTempEnv(sandbox), ...extras };
  env[QA_MODE_ENV] = '1';
  env[QA_ROOT_ENV] = sandbox.root;
  env.APPDATA = sandbox.appData;
  env.LOCALAPPDATA = sandbox.localAppData;
  env.XDG_DATA_HOME = path.join(sandbox.root, 'xdg-data');
  env.XDG_CACHE_HOME = path.join(sandbox.root, 'xdg-cache');
  env.XDG_CONFIG_HOME = path.join(sandbox.root, 'xdg-config');
  mkdirSync(env.XDG_DATA_HOME, { recursive: true });
  mkdirSync(env.XDG_CACHE_HOME, { recursive: true });
  mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
  mkdirSync(env.YAQMC_CREDENTIAL_DIR, { recursive: true });
  mkdirSync(env.YAQMC_PLUGIN_FALLBACK_DIR, { recursive: true });
  mkdirSync(env.YAQMC_LOG_FALLBACK_DIR, { recursive: true });
  mkdirSync(env.YAQMC_DOWNLOAD_DIR, { recursive: true });
  return env;
}

export function electronQaArgs(sandbox, extra = []) {
  return ['.', `--user-data-dir=${sandbox.electronUserData}`, ...extra];
}

export function requireQaSandboxFromEnv(env = process.env, lookup = {}) {
  if (!isQaLaunch(env)) {
    return null;
  }
  return assertQaRootNotProduction(env[QA_ROOT_ENV], {
    platform: lookup.platform,
    homedir: lookup.homedir ?? env.USERPROFILE ?? env.HOME,
    env,
  });
}

export function hashDirectory(root) {
  const files = [];
  collectFiles(root, root, files);
  files.sort((left, right) => left.rel.localeCompare(right.rel));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.rel);
    hash.update('\0');
    hash.update(readFileSync(file.abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function collectFiles(root, current, out) {
  for (const name of readdirSync(current)) {
    const abs = path.join(current, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      collectFiles(root, abs, out);
    } else if (st.isFile()) {
      out.push({
        abs,
        rel: path.relative(root, abs).replaceAll('\\', '/'),
      });
    }
  }
}
