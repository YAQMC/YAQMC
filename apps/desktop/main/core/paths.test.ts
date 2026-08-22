import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANDSHAKE_TIMEOUT_MS, SHUTDOWN_TIMEOUT_MS } from '@yaqmc/client';
import { tryResolveCoreBinary, CoreSupervisor } from './supervisor';
import { APP_IDENTIFIER, librarySqlitePath, localApiConfigPath, resolveCorePaths } from './paths';

describe('BASE-04 core path resolution', () => {
  it('matches the Windows SOURCE-VERIFIED table on a scratch profile', () => {
    const scratch = path.win32.join('D:', 'scratch-profile');
    const env = {
      APPDATA: path.win32.join(scratch, 'Roaming'),
      LOCALAPPDATA: path.win32.join(scratch, 'Local'),
    };
    const paths = resolveCorePaths({ platform: 'win32', env, homedir: scratch });
    expect(paths).toEqual({
      dataDir: path.win32.join(env.APPDATA, APP_IDENTIFIER),
      cacheDir: path.win32.join(env.LOCALAPPDATA, APP_IDENTIFIER),
      logDir: path.win32.join(env.LOCALAPPDATA, APP_IDENTIFIER, 'logs'),
      configDir: path.win32.join(env.APPDATA, APP_IDENTIFIER),
    });
    expect(localApiConfigPath(paths, 'win32')).toBe(
      path.win32.join(env.APPDATA, APP_IDENTIFIER, 'local-api.json'),
    );
    expect(librarySqlitePath(paths, 'win32')).toBe(
      path.win32.join(env.APPDATA, APP_IDENTIFIER, 'library.sqlite3'),
    );
  });

  it('matches the Linux SOURCE-VERIFIED table with XDG fallbacks', () => {
    const home = '/home/scratch';
    const fallback = resolveCorePaths({ platform: 'linux', env: {}, homedir: home });
    expect(fallback).toEqual({
      dataDir: `${home}/.local/share/${APP_IDENTIFIER}`,
      cacheDir: `${home}/.cache/${APP_IDENTIFIER}`,
      logDir: `${home}/.local/share/${APP_IDENTIFIER}/logs`,
      configDir: `${home}/.config/${APP_IDENTIFIER}`,
    });
    const env = {
      XDG_DATA_HOME: '/xdg/data',
      XDG_CACHE_HOME: '/xdg/cache',
      XDG_CONFIG_HOME: '/xdg/config',
    };
    const overlay = resolveCorePaths({ platform: 'linux', env, homedir: home });
    expect(overlay).toEqual({
      dataDir: `/xdg/data/${APP_IDENTIFIER}`,
      cacheDir: `/xdg/cache/${APP_IDENTIFIER}`,
      logDir: `/xdg/data/${APP_IDENTIFIER}/logs`,
      configDir: `/xdg/config/${APP_IDENTIFIER}`,
    });
    expect(localApiConfigPath(overlay, 'linux')).toBe(
      `/xdg/config/${APP_IDENTIFIER}/local-api.json`,
    );
  });
});

const liveBinary = tryResolveCoreBinary({
  env: process.env,
  cargoTargetDir: process.env.CARGO_TARGET_DIR,
});

describe.skipIf(!liveBinary || process.platform !== 'win32')(
  'first-boot path-parity (scratch profile vs BASE-04)',
  () => {
    it('creates library.sqlite3 under %APPDATA%\\org.yaqmc.desktop', async () => {
      const scratch = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-path-parity-'));
      const env = {
        APPDATA: path.join(scratch, 'Roaming'),
        LOCALAPPDATA: path.join(scratch, 'Local'),
        USERPROFILE: scratch,
      };
      const paths = resolveCorePaths({ platform: 'win32', env, homedir: scratch });
      const supervisor = new CoreSupervisor({
        binary: liveBinary as string,
        hostVersion: '0.1.0',
        expectedCoreVersion: '0.1.0',
        handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
        shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
        ...paths,
      });
      await supervisor.start();
      expect(existsSync(librarySqlitePath(paths, 'win32'))).toBe(true);
      expect(paths.dataDir).toBe(path.join(env.APPDATA, APP_IDENTIFIER));
      expect(paths.cacheDir).toBe(path.join(env.LOCALAPPDATA, APP_IDENTIFIER));
      expect(paths.logDir).toBe(path.join(env.LOCALAPPDATA, APP_IDENTIFIER, 'logs'));
      await supervisor.stop();
    }, 20_000);
  },
);
