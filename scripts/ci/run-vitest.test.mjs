import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeNodeOptions } from '../run-vitest.mjs';

test('adds the Node Web Storage disable flag to empty options', () => {
  assert.equal(mergeNodeOptions(''), '--no-experimental-webstorage');
});

test('preserves existing NODE_OPTIONS while appending the disable flag', () => {
  assert.equal(
    mergeNodeOptions('--trace-warnings --max-old-space-size=2048'),
    '--trace-warnings --max-old-space-size=2048 --no-experimental-webstorage',
  );
});

test('does not duplicate an existing Node Web Storage disable flag', () => {
  assert.equal(
    mergeNodeOptions('--trace-warnings --no-experimental-webstorage'),
    '--trace-warnings --no-experimental-webstorage',
  );
});
