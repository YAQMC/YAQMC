import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ELECTRON_PACKAGE_TARGETS,
  selectElectronPackageMatrix,
} from './select-electron-package-matrix.mjs';

test('pull requests only pack Electron smoke targets', () => {
  const selected = selectElectronPackageMatrix({ eventName: 'pull_request' });
  assert.deepEqual(
    selected.map((row) => `${row.os}-${row.arch}`),
    ['windows-x64', 'linux-x64'],
  );
  assert.ok(selected.every((row) => row.smoke));
});

test('main pushes pack the full Electron matrix without i686', () => {
  const selected = selectElectronPackageMatrix({ eventName: 'push' });
  assert.equal(selected.length, ELECTRON_PACKAGE_TARGETS.length);
  assert.equal(selected.length, 4);
  assert.ok(!selected.some((row) => row.arch === 'ia32' || row.arch === 'i686'));
  assert.deepEqual(
    selected.map((row) => `${row.os}-${row.arch}`),
    ['windows-x64', 'windows-arm64', 'linux-x64', 'linux-arm64'],
  );
});

test('manual dispatch can limit the Electron matrix to one OS', () => {
  const selected = selectElectronPackageMatrix({
    eventName: 'workflow_dispatch',
    targets: 'linux',
  });
  assert.deepEqual(
    selected.map((row) => row.arch),
    ['x64', 'arm64'],
  );
  assert.ok(selected.every((row) => row.os === 'linux'));
});

test('Windows arm64 is a cross-compile on windows-2025, not windows-11-arm', () => {
  const arm = ELECTRON_PACKAGE_TARGETS.find((row) => row.os === 'windows' && row.arch === 'arm64');
  assert.equal(arm.runner, 'windows-2025');
  assert.equal(arm.target, 'aarch64-pc-windows-msvc');
  assert.equal(arm.cross, true);
  assert.equal(arm.smoke, false);
});

test('Linux arm64 uses the FACT ubuntu-22.04-arm runner', () => {
  const arm = ELECTRON_PACKAGE_TARGETS.find((row) => row.os === 'linux' && row.arch === 'arm64');
  assert.equal(arm.runner, 'ubuntu-22.04-arm');
  assert.equal(arm.target, 'aarch64-unknown-linux-gnu');
  assert.equal(arm.cross, false);
});
