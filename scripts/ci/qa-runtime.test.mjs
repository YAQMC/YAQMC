import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import {
  APP_IDENTIFIER,
  QA_SANDBOX_DIR_NAME,
  assertIsQaSandbox,
  assertProductionAttachAllowed,
  assertSandboxNotProduction,
  cleanupQaSandbox,
  createQaSandbox,
  electronQaArgs,
  hashDirectory,
  isQaLaunch,
  isSameOrInsidePath,
  qaElectronEnv,
  requireQaSandboxFromEnv,
  resolveProductionCoreRoots,
  stripQaLaunchFlags,
  coreTempEnv,
} from '../qa-runtime.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function fakeMaintainerEnv(root) {
  return {
    USERPROFILE: root,
    HOME: root,
  };
}

function seedMaintainer(root) {
  const env = fakeMaintainerEnv(root);
  const prod = resolveProductionCoreRoots({ env, platform: 'win32', homedir: root });
  for (const dir of [prod.dataDir, prod.cacheDir, prod.electronUserDataUnpackaged]) {
    if (!isSameOrInsidePath(dir, root)) {
      throw new Error(`refusing to mkdir ${dir} outside fake maintainer root ${root}`);
    }
  }
  mkdirSync(prod.dataDir, { recursive: true });
  mkdirSync(prod.cacheDir, { recursive: true });
  mkdirSync(prod.electronUserDataUnpackaged, { recursive: true });
  writeFileSync(path.join(prod.dataDir, 'library.sqlite3'), 'prod-db-bytes');
  writeFileSync(path.join(prod.dataDir, 'ui-preferences-sentinel'), '{"showFpsCounter":false}');
  writeFileSync(path.join(prod.cacheDir, 'marker.bin'), Buffer.from('cache-sentinel'));
  return { env, prod };
}

after(() => {
  const leaked = readdirSync(repoRoot).filter((name) => name.includes('\\'));
  assert.deepEqual(leaked, [], `win32-joined paths leaked into the repository root: ${leaked}`);
});

function simulatePerfHarness(parentEnv) {
  const sandbox = createQaSandbox({ purpose: 'sentinel-perf', env: parentEnv });
  const env = qaElectronEnv(parentEnv, sandbox, {
    YAQMC_UI_PERF_DIAG: '1',
    YAQMC_ELECTRON_E2E: '1',
    YAQMC_E2E_CORE: '1',
  });
  writeFileSync(path.join(sandbox.coreData, 'library.sqlite3'), 'sandbox-db');
  writeFileSync(
    path.join(sandbox.coreData, 'prefs.json'),
    JSON.stringify({ debug: { showFpsCounter: true }, appearance: { backgroundMode: 'artwork' } }),
  );
  writeFileSync(path.join(sandbox.diagnostics, 'lyrics-occlusion.json'), '{"cause":"sentinel"}');
  return { sandbox, env };
}

test('QA launch flags are detected and production attach is fail-closed', () => {
  assert.equal(isQaLaunch({}), false);
  assert.equal(isQaLaunch({ YAQMC_ELECTRON_E2E: '1' }), true);
  assert.equal(isQaLaunch({ YAQMC_UI_PERF_DIAG: '1' }), true);
  assert.equal(isQaLaunch({ YAQMC_DESKTOP_SMOKE: '1' }), true);
  assert.throws(() => assertProductionAttachAllowed({}, 'probe'), /YAQMC_ALLOW_PRODUCTION_ATTACH/);
  assert.doesNotThrow(() =>
    assertProductionAttachAllowed({ YAQMC_ALLOW_PRODUCTION_ATTACH: '1' }, 'probe'),
  );
});

test('createQaSandbox is unique per run and never the maintainer Core root', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-maintainer-'));
  const { env, prod } = seedMaintainer(home);
  const first = createQaSandbox({ purpose: 'a', env });
  const second = createQaSandbox({ purpose: 'b', env });
  assert.notEqual(first.root, second.root);
  assert.notEqual(first.coreData, prod.dataDir);
  assert.notEqual(first.electronUserData, prod.electronUserDataUnpackaged);
  assert.match(first.root.replaceAll('\\', '/'), new RegExp(`/${QA_SANDBOX_DIR_NAME}/`));
  const launched = qaElectronEnv(env, first, { YAQMC_ELECTRON_E2E: '1' });
  assert.equal(launched.YAQMC_QA_MODE, '1');
  assert.equal(launched.YAQMC_QA_ROOT, first.root);
  assert.notEqual(launched.APPDATA, env.APPDATA);
  cleanupQaSandbox(first.root, { env });
  cleanupQaSandbox(second.root, { env });
});

test('Electron test args pin a unique userData under the sandbox', () => {
  const sandbox = createQaSandbox({ purpose: 'e2e-args' });
  const args = electronQaArgs(sandbox, ['--lang=en-US']);
  assert.equal(args[0], '.');
  assert.equal(args[1], `--user-data-dir=${sandbox.electronUserData}`);
  assert.ok(args[1].includes('electron-user-data'));
  cleanupQaSandbox(sandbox.root);
});

test('QA Core cannot resolve to the normal dev Core root', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-maintainer-'));
  const { env, prod } = seedMaintainer(home);
  assert.throws(
    () => requireQaSandboxFromEnv({ YAQMC_ELECTRON_E2E: '1' }, { env }),
    /YAQMC_QA_ROOT is required/,
  );
  assert.throws(
    () =>
      requireQaSandboxFromEnv(
        { YAQMC_ELECTRON_E2E: '1', YAQMC_QA_ROOT: prod.dataDir },
        { env, homedir: home, platform: 'win32' },
      ),
    /overlaps production/,
  );
  assert.equal(requireQaSandboxFromEnv({}, { env }), null);
});

test('cleanup cannot delete outside a marked yaqmc-qa sandbox', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-maintainer-'));
  const { env, prod } = seedMaintainer(home);
  assert.throws(
    () => cleanupQaSandbox(prod.dataDir, { env }),
    /not under yaqmc-qa|no \.yaqmc-qa-sandbox/,
  );
  assert.throws(() => assertIsQaSandbox(prod.dataDir), /not under yaqmc-qa/);
  const decoy = mkdtempSync(path.join(os.tmpdir(), 'not-qa-'));
  writeFileSync(path.join(decoy, '.yaqmc-qa-sandbox'), '{}\n');
  assert.throws(() => cleanupQaSandbox(decoy, { env }), /not under yaqmc-qa/);
});

test('sentinel: mutating perf harness leaves a fake maintainer root byte-identical', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-maintainer-'));
  const { env, prod } = seedMaintainer(home);
  const before = hashDirectory(home);
  const { sandbox, env: harnessEnv } = simulatePerfHarness(env);
  assert.equal(harnessEnv.YAQMC_UI_PERF_DIAG, '1');
  assert.notEqual(sandbox.coreData, prod.dataDir);
  const afterHash = hashDirectory(home);
  assert.equal(afterHash, before);
  cleanupQaSandbox(sandbox.root, { env });
  assert.equal(hashDirectory(home), before);
});

test('failed/hung profiler still cannot point Core at production', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-maintainer-'));
  const { env, prod } = seedMaintainer(home);
  const before = hashDirectory(home);
  const sandbox = createQaSandbox({ purpose: 'hung-profiler', env });
  writeFileSync(path.join(sandbox.coreData, 'partial.json'), '{"hung":true}');
  assert.throws(
    () => assertSandboxNotProduction(prod.dataDir, { env, platform: 'win32', homedir: home }),
    /overlaps production/,
  );
  assert.equal(hashDirectory(home), before);
  cleanupQaSandbox(sandbox.root, { env });
});

test('dev:desktop strips QA flags so HUMAN cannot inherit a test Core', () => {
  const stripped = stripQaLaunchFlags({
    YAQMC_VITE_DEV: '1',
    YAQMC_ELECTRON_E2E: '1',
    YAQMC_QA_ROOT: 'C:\\tmp\\yaqmc-qa\\stale',
    YAQMC_QA_MODE: '1',
    YAQMC_UI_PERF_DIAG: '1',
    YAQMC_CREDENTIAL_DIR: 'C:\\tmp\\yaqmc-qa\\stale\\core-data\\credentials',
    YAQMC_CORE_BIN: 'D:\\core\\yaqmc-core.exe',
    PATH: '/bin',
  });
  assert.equal(stripped.YAQMC_ELECTRON_E2E, undefined);
  assert.equal(stripped.YAQMC_QA_ROOT, undefined);
  assert.equal(stripped.YAQMC_UI_PERF_DIAG, undefined);
  assert.equal(stripped.YAQMC_CREDENTIAL_DIR, undefined);
  assert.equal(stripped.YAQMC_CORE_BIN, 'D:\\core\\yaqmc-core.exe');
  const source = readFileSync(path.join(repoRoot, 'scripts', 'dev-desktop.mjs'), 'utf8');
  assert.match(source, /stripQaLaunchFlags/);
});

test('perf artifacts cannot enter packaging inputs', () => {
  const gitignore = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  assert.match(gitignore, /^output\//m);
  const yaml = readFileSync(path.join(repoRoot, 'apps', 'desktop', 'electron-builder.yml'), 'utf8');
  assert.doesNotMatch(yaml, /from:\s*\.\.\/\.\.\/output/);
  assert.doesNotMatch(yaml, /from:\s*output/);
  assert.match(yaml, /from: resources\/core/);
});

test('two simultaneous test runs do not share Core or Electron state', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-maintainer-'));
  const { env } = seedMaintainer(home);
  const left = createQaSandbox({ purpose: 'parallel-a', env });
  const right = createQaSandbox({ purpose: 'parallel-b', env });
  assert.notEqual(left.root, right.root);
  assert.notEqual(left.coreData, right.coreData);
  assert.notEqual(left.electronUserData, right.electronUserData);
  assert.notEqual(coreTempEnv(left).YAQMC_CREDENTIAL_DIR, coreTempEnv(right).YAQMC_CREDENTIAL_DIR);
  writeFileSync(path.join(left.coreData, 'library.sqlite3'), 'left');
  writeFileSync(path.join(right.coreData, 'library.sqlite3'), 'right');
  assert.notEqual(
    readFileSync(path.join(left.coreData, 'library.sqlite3'), 'utf8'),
    readFileSync(path.join(right.coreData, 'library.sqlite3'), 'utf8'),
  );
  cleanupQaSandbox(left.root, { env });
  cleanupQaSandbox(right.root, { env });
});

test('QA Core child env keeps credentials and plugin fallback inside the sandbox', () => {
  const sandbox = createQaSandbox({ purpose: 'core-child-env' });
  const childEnv = coreTempEnv(sandbox);
  assert.equal(childEnv.YAQMC_CREDENTIAL_DIR, path.join(sandbox.coreData, 'credentials'));
  assert.equal(childEnv.YAQMC_PLUGIN_FALLBACK_DIR, sandbox.plugins);
  assert.ok(childEnv.YAQMC_CREDENTIAL_DIR.startsWith(sandbox.root));
  const launched = qaElectronEnv(process.env, sandbox, { YAQMC_UI_PERF_DIAG: '1' });
  assert.equal(launched.YAQMC_CREDENTIAL_DIR, childEnv.YAQMC_CREDENTIAL_DIR);
  cleanupQaSandbox(sandbox.root);
});

test('ACC-02 profile probe refuse production overlap and strip QA flags', () => {
  const source = readFileSync(
    path.join(repoRoot, 'scripts', 'migration', 'acc02-profile-dirs.mjs'),
    'utf8',
  );
  assert.match(source, /stripQaLaunchFlags/);
  assert.match(source, /overlaps production Core data/);
  const play03 = readFileSync(
    path.join(repoRoot, 'scripts', 'migration', 'acc02-play03-cdp.mjs'),
    'utf8',
  );
  assert.match(play03, /assertProductionAttachAllowed/);
  const dwm = readFileSync(
    path.join(repoRoot, 'scripts', 'migration', 'acc02-dwm-css.mjs'),
    'utf8',
  );
  assert.match(dwm, /assertProductionAttachAllowed/);
});

test('production identifier stays org.yaqmc.desktop', () => {
  assert.equal(APP_IDENTIFIER, 'org.yaqmc.desktop');
  const roots = resolveProductionCoreRoots({
    platform: 'win32',
    homedir: 'D:\\scratch',
  });
  assert.equal(roots.dataDir, path.win32.join('D:\\scratch', 'AppData', 'Roaming', APP_IDENTIFIER));
});

test('a POSIX maintainer homedir with platform win32 stays under that homedir', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-maintainer-'));
  const { prod } = seedMaintainer(home);
  assert.ok(isSameOrInsidePath(prod.dataDir, home));
  assert.ok(isSameOrInsidePath(prod.cacheDir, home));
  assert.ok(isSameOrInsidePath(prod.electronUserDataUnpackaged, home));
  if (process.platform !== 'win32') {
    assert.equal(prod.dataDir, path.posix.join(home, 'AppData', 'Roaming', APP_IDENTIFIER));
    assert.doesNotMatch(prod.dataDir, /\\/);
  }
});
