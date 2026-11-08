import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  coreBuildEnv,
  coreCargoArgs,
  checkDesktopDevDependencies,
  desktopDevUrl,
  electronDevEnv,
  waitForFile,
  waitForTcp,
  watchDevProcess,
} from '../dev-desktop.mjs';
import { fileURLToPath } from 'node:url';

function temporaryProject(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-dev-desktop-'));
  t.after(() => {
    assert.ok(path.isAbsolute(root) && path.basename(root).startsWith('yaqmc-dev-desktop-'));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function putFile(root, relative, contents) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function installFixtureTools(root) {
  putFile(root, 'node_modules/vite/package.json', '{"name":"vite"}');
  putFile(root, 'node_modules/vite/bin/vite.js', '');
  for (const relative of ['apps/desktop/node_modules/esbuild', 'node_modules/electron']) {
    putFile(root, `${relative}/package.json`, '{"main":"index.js"}');
    putFile(
      root,
      `${relative}/index.js`,
      'throw new Error("preflight must not execute packages");',
    );
  }
}

test('dependency checks resolve nested workspace tools without executing them', (t) => {
  const root = temporaryProject(t);
  installFixtureTools(root);
  assert.equal(
    checkDesktopDevDependencies(root).viteCli,
    path.join(root, 'node_modules/vite/bin/vite.js'),
  );
  const incomplete = temporaryProject(t);
  installFixtureTools(incomplete);
  rmSync(path.join(incomplete, 'apps/desktop/node_modules/esbuild/index.js'));
  assert.throws(
    () => checkDesktopDevDependencies(incomplete),
    /Missing desktop development dependencies: esbuild/,
  );
});

test('a checkout without npm dependencies fails before Cargo and reports the install command', (t) => {
  const root = temporaryProject(t);
  const scriptDirectory = fileURLToPath(new URL('..', import.meta.url));
  mkdirSync(path.join(root, 'scripts'));
  for (const name of ['dev-desktop.mjs', 'qa-runtime.mjs']) {
    copyFileSync(path.join(scriptDirectory, name), path.join(root, 'scripts', name));
  }
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/dev-desktop.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing desktop development dependencies: vite, esbuild, electron/);
  assert.match(result.stderr, /npm ci --include=dev --workspaces --include-workspace-root/);
  assert.doesNotMatch(result.stderr, /Cargo\.toml|timed out waiting|ERR_MODULE_NOT_FOUND/);
});

test(
  'a failed build watcher aborts both readiness waits with its original exit code',
  { timeout: 5_000 },
  async (t) => {
    const root = temporaryProject(t);
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const controller = new globalThis.AbortController();
    const child = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    watchDevProcess(child, 'Electron build watcher', controller);
    const results = await Promise.allSettled([
      waitForTcp('127.0.0.1', port, 30_000, controller.signal),
      waitForFile(path.join(root, 'missing.js'), 30_000, controller.signal),
    ]);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason, controller.signal.reason);
      assert.match(result.reason.message, /Electron build watcher exited with code 7/);
    }
  },
);

test(
  'a process spawn error aborts startup without waiting for a file',
  { timeout: 5_000 },
  async (t) => {
    const root = temporaryProject(t);
    const controller = new globalThis.AbortController();
    const child = spawn(path.join(root, 'missing-vite-executable'), [], { stdio: 'ignore' });
    watchDevProcess(child, 'Vite', controller);
    await assert.rejects(
      waitForFile(path.join(root, 'missing.js'), 30_000, controller.signal),
      /Vite failed to start/,
    );
  },
);

test('core cargo args build the production qmapi-linked Core', () => {
  assert.deepEqual(coreCargoArgs({}), ['build', '-p', 'yaqmc-core']);
});

test('Core builds default CARGO_NET_GIT_FETCH_WITH_CLI to true and preserve an override', () => {
  assert.equal(coreBuildEnv({ PATH: '/bin' }).CARGO_NET_GIT_FETCH_WITH_CLI, 'true');
  assert.equal(
    coreBuildEnv({
      PATH: '/bin',
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
