import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  coreBuildEnv,
  coreCargoArgs,
  desktopDevUrl,
  electronDevEnv,
  waitForFile,
  waitForTcp,
} from '../dev-desktop.mjs';
import { fileURLToPath } from 'node:url';

test('core cargo args stay intree unless YAQMC_CORE_FEATURES is set', () => {
  assert.deepEqual(coreCargoArgs({}), ['build', '-p', 'yaqmc-core']);
  assert.deepEqual(coreCargoArgs({ YAQMC_CORE_FEATURES: 'qqmusic-qmapi' }), [
    'build',
    '-p',
    'yaqmc-core',
    '--features',
    'qqmusic-qmapi',
  ]);
});

test('qmapi Core builds honor git insteadOf via CARGO_NET_GIT_FETCH_WITH_CLI', () => {
  assert.equal(coreBuildEnv({ PATH: '/bin' }).CARGO_NET_GIT_FETCH_WITH_CLI, undefined);
  assert.equal(
    coreBuildEnv({ PATH: '/bin', YAQMC_CORE_FEATURES: 'qqmusic-qmapi' })
      .CARGO_NET_GIT_FETCH_WITH_CLI,
    'true',
  );
  assert.equal(
    coreBuildEnv({
      PATH: '/bin',
      YAQMC_CORE_FEATURES: 'qqmusic-qmapi',
      CARGO_NET_GIT_FETCH_WITH_CLI: 'false',
    }).CARGO_NET_GIT_FETCH_WITH_CLI,
    'false',
  );
});

test('dev:desktop stages the debug Core it just built', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../dev-desktop.mjs', import.meta.url)),
    'utf8',
  );
  assert.match(source, /stage-core\.mjs/);
  assert.match(source, /--profile['",\s]+debug/);
});

test('desktop dev URL is the Vite 1420 origin', () => {
  assert.equal(desktopDevUrl(), 'http://127.0.0.1:1420/');
});

test('Electron dev env opts the main window into the Vite origin and strips QA flags', () => {
  const env = electronDevEnv({
    PATH: '/bin',
    YAQMC_ELECTRON_E2E: '1',
    YAQMC_QA_ROOT: '/tmp/yaqmc-qa/stale',
    YAQMC_UI_PERF_DIAG: '1',
  });
  assert.equal(env.YAQMC_VITE_DEV, '1');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.YAQMC_ELECTRON_E2E, undefined);
  assert.equal(env.YAQMC_QA_ROOT, undefined);
  assert.equal(env.YAQMC_UI_PERF_DIAG, undefined);
});

test('waitForTcp resolves once the port accepts connections', async () => {
  const server = createServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await waitForTcp('127.0.0.1', address.port, 5_000);
  server.close();
});

test('waitForFile resolves when the path appears', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-dev-desktop-'));
  const filePath = path.join(dir, 'index.js');
  setTimeout(() => writeFileSync(filePath, 'ok'), 50);
  await waitForFile(filePath, 5_000);
});
