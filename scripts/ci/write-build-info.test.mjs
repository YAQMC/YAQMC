import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256File, verifySha256Sums, writeSha256Sums } from './write-build-info.mjs';

test('checksums cover the final staged names and then verify', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-sums-'));
  const name = 'YAQMC-0.1.0-windows-x86_64-abcdef1-nsis-setup.exe';
  writeFileSync(path.join(directory, name), 'installer');
  const sumsPath = writeSha256Sums(directory, [name], 'SHA256SUMS-windows-x86_64.txt');
  assert.equal(sha256File(path.join(directory, name)).length, 64);
  verifySha256Sums(sumsPath);
});
