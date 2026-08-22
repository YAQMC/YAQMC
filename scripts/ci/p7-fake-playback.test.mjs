import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { repositoryRoot } from './repo.mjs';

test('PLAY-01 fake-playback runner exits 0 against createFakeBridge', () => {
  const script = path.join(repositoryRoot, 'scripts', 'migration', 'p7-fake-playback.mjs');
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    cwd: repositoryRoot,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /1 passed/);
});
