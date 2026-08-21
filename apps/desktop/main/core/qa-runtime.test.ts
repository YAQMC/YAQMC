import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  APP_IDENTIFIER,
  assertSandboxNotProduction,
  coreTempEnv,
  describeSandbox,
  isQaLaunch,
  isSameOrInsidePath,
  requireQaSandboxFromEnv,
  resolveProductionCoreRoots,
} from './qa-runtime';

const repoRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

function seed(root: string) {
  const env = {
    USERPROFILE: root,
    HOME: root,
  };
  const prod = resolveProductionCoreRoots({ env, platform: 'win32', homedir: root });
  if (!isSameOrInsidePath(prod.dataDir, root)) {
    throw new Error(`refusing to mkdir ${prod.dataDir} outside fake maintainer root ${root}`);
  }
  mkdirSync(prod.dataDir, { recursive: true });
  writeFileSync(path.join(prod.dataDir, 'library.sqlite3'), 'prod');
  return { env, prod };
}

afterAll(() => {
  const leaked = readdirSync(repoRoot).filter((name) => name.includes('\\'));
  expect(leaked, `win32-joined paths leaked into the repository root: ${leaked}`).toEqual([]);
});

describe('QA sandbox fail-closed guard', () => {
  it('detects QA launch flags', () => {
    expect(isQaLaunch({})).toBe(false);
    expect(isQaLaunch({ YAQMC_ELECTRON_E2E: '1' })).toBe(true);
    expect(isQaLaunch({ YAQMC_UI_PERF_DIAG: '1' })).toBe(true);
    expect(isQaLaunch({ YAQMC_DESKTOP_SMOKE: '1' })).toBe(true);
    expect(isQaLaunch({ YAQMC_QA_MODE: '1' })).toBe(true);
  });

  it('refuses to start Core when a QA flag is set without YAQMC_QA_ROOT', () => {
    expect(() => requireQaSandboxFromEnv({ YAQMC_ELECTRON_E2E: '1' })).toThrow(
      /YAQMC_QA_ROOT is required before starting Core/,
    );
  });

  it('refuses a sandbox that resolves to the maintainer Core root', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-qa-prod-'));
    const { env, prod } = seed(home);
    expect(() =>
      requireQaSandboxFromEnv(
        { YAQMC_UI_PERF_DIAG: '1', YAQMC_QA_ROOT: prod.dataDir },
        { env, platform: 'win32', homedir: home },
      ),
    ).toThrow(/overlaps production/);
    expect(() =>
      assertSandboxNotProduction(prod.dataDir, { env, platform: 'win32', homedir: home }),
    ).toThrow(/overlaps production/);
  });

  it('accepts a unique sandbox that is not the production identifier tree', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-qa-prod-'));
    const { env, prod } = seed(home);
    const sandboxRoot = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-qa-ok-'));
    const sandbox = describeSandbox(sandboxRoot);
    expect(sandbox.corePaths.dataDir).not.toBe(prod.dataDir);
    expect(
      requireQaSandboxFromEnv(
        { YAQMC_ELECTRON_E2E: '1', YAQMC_QA_ROOT: sandbox.root },
        { env, platform: 'win32', homedir: home },
      )?.coreData,
    ).toBe(sandbox.coreData);
  });

  it('keeps the production Core identifier', () => {
    expect(APP_IDENTIFIER).toBe('org.yaqmc.desktop');
  });

  it('points Core credentials and plugin fallback at the sandbox', () => {
    const sandbox = describeSandbox(path.join(os.tmpdir(), 'yaqmc-qa', 'unit-run'));
    const env = coreTempEnv(sandbox);
    expect(env.YAQMC_CREDENTIAL_DIR).toBe(path.join(sandbox.coreData, 'credentials'));
    expect(env.YAQMC_PLUGIN_FALLBACK_DIR).toBe(sandbox.plugins);
    expect(env.TEMP).toBe(sandbox.tmp);
  });
});
