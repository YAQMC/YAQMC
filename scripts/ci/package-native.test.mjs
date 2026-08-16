import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { workspaceBinaryCandidates } from './package-native.mjs';

test('locates Windows binaries under the root workspace target directory', () => {
  assert.deepEqual(workspaceBinaryCandidates('x86_64-pc-windows-msvc', 'windows'), [
    path.join(process.cwd(), 'target', 'x86_64-pc-windows-msvc', 'release', 'yaqmc.exe'),
    path.join(process.cwd(), 'target', 'release', 'yaqmc.exe'),
  ]);
});

test('locates Linux binaries under the root workspace target directory', () => {
  assert.deepEqual(workspaceBinaryCandidates('aarch64-unknown-linux-gnu', 'linux'), [
    path.join(process.cwd(), 'target', 'aarch64-unknown-linux-gnu', 'release', 'yaqmc'),
    path.join(process.cwd(), 'target', 'release', 'yaqmc'),
  ]);
});
