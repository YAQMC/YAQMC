import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findReleaseBinary } from './stage-artifacts.mjs';

test('uses the release-root binary instead of a nested bundle copy', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-stage-'));
  const nested = path.join(root, 'bundle', 'nsis', 'payload');
  mkdirSync(nested, { recursive: true });
  const realBinary = path.join(root, 'yaqmc.exe');
  writeFileSync(realBinary, 'real');
  writeFileSync(path.join(nested, 'yaqmc.exe'), 'nested');
  assert.equal(findReleaseBinary('windows', root, path.join(root, 'missing')), realBinary);
});

test('falls back to the host release directory', () => {
  const host = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-host-'));
  const target = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-target-'));
  const hostBinary = path.join(host, 'yaqmc');
  writeFileSync(hostBinary, 'host');
  assert.equal(findReleaseBinary('linux', target, host), hostBinary);
});
