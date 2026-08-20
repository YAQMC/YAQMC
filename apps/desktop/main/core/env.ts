/**
 * Allowlisted parent-environment passthrough for the yaqmc-core child.
 *
 * CoreSupervisor used to spread `process.env` into spawn. That forwarded
 * Electron/WebKit, Node, CI tokens, and arbitrary user secrets into the same
 * process that talks to Secret Service / MPRIS. This module copies only the
 * committed list below.
 *
 * Linux keyring (Secret Service) and MPRIS both use the session bus, so
 * `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` must be inherited. DISPLAY /
 * WAYLAND_DISPLAY / XAUTHORITY cover session-bus autolaunch fallbacks. Live
 * keyring+MPRIS verification is Linux-only (ACCT-03 / PLAT-05); unit tests are
 * the gate on Windows builders. This list does not claim MPRIS or SMTC green.
 *
 * Windows process start and the ELEC-03 handshake need PATH, SYSTEMROOT, and
 * the user-profile vars (`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`).
 *
 * Matching is case-insensitive so Windows `Path` / `SystemRoot` still copy.
 * `LC_*` matches by prefix in addition to the exact locale keys. Parent
 * `YAQMC_*` lookup/debug vars are not forwarded except `YAQMC_LOG_LEVEL`; the
 * supervisor always sets data/cache/log/config/channel after the allowlist.
 */

export const CORE_SPAWN_ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TMPDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'TZ',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_TYPE',
  'XDG_SESSION_ID',
  'XDG_SESSION_CLASS',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'YAQMC_LOG_LEVEL',
] as const;

const ALLOWLIST_LOOKUP = new Set(CORE_SPAWN_ENV_ALLOWLIST.map((key) => key.toUpperCase()));

export type CoreSpawnEnvInputs = {
  parentEnv?: NodeJS.ProcessEnv;
  extraEnv?: NodeJS.ProcessEnv;
  dataDir: string;
  cacheDir: string;
  logDir: string;
  configDir: string;
  channel?: string;
};

export function isAllowlistedCoreSpawnEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return upper.startsWith('LC_') || ALLOWLIST_LOOKUP.has(upper);
}

export function buildCoreSpawnEnv(inputs: CoreSpawnEnvInputs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  copyMatching(env, inputs.parentEnv ?? process.env, isAllowlistedCoreSpawnEnvKey);
  copyMatching(env, inputs.extraEnv, isHostOverlayEnvKey);
  env.YAQMC_DATA_DIR = inputs.dataDir;
  env.YAQMC_CACHE_DIR = inputs.cacheDir;
  env.YAQMC_LOG_DIR = inputs.logDir;
  env.YAQMC_CONFIG_DIR = inputs.configDir;
  env.YAQMC_CHANNEL = inputs.channel ?? 'desktop';
  return env;
}

function isHostOverlayEnvKey(key: string): boolean {
  return isAllowlistedCoreSpawnEnvKey(key) || key.startsWith('YAQMC_');
}

function copyMatching(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv | undefined,
  allow: (key: string) => boolean,
): void {
  if (!source) {
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || !allow(key)) {
      continue;
    }
    target[key] = value;
  }
}
