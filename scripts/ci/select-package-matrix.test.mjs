import assert from 'node:assert/strict';
import test from 'node:test';
import { PACKAGE_TARGETS, selectPackageMatrix } from './select-package-matrix.mjs';

test('pull requests only package the smoke targets', () => {
  const selected = selectPackageMatrix({ eventName: 'pull_request' });
  assert.deepEqual(
    selected.map((row) => `${row.os}-${row.arch}`),
    ['windows-x86_64', 'linux-x86_64'],
  );
});

test('main pushes package the full matrix', () => {
  assert.equal(selectPackageMatrix({ eventName: 'push' }).length, PACKAGE_TARGETS.length);
});

test('manual dispatch can limit the matrix to one OS', () => {
  const selected = selectPackageMatrix({ eventName: 'workflow_dispatch', targets: 'linux' });
  assert.deepEqual(
    selected.map((row) => row.arch),
    ['x86_64', 'aarch64'],
  );
  assert.ok(selected.every((row) => row.os === 'linux'));
});
