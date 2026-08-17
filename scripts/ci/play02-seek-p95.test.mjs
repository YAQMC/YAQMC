import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { repositoryRoot } from './repo.mjs';

test('PLAY-02 assist prints PENDING seek p95 cells and no invented number', () => {
  const script = path.join(repositoryRoot, 'scripts', 'migration', 'play02-seek-p95.mjs');
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.id, 'PLAY-02');
  assert.equal(payload.Windows.state, 'PENDING');
  assert.equal(payload.Linux.state, 'PENDING');
  assert.equal(payload.Windows.p95Ms, null);
  assert.equal(payload.Linux.p95Ms, null);
  assert.doesNotMatch(result.stdout, /"p95Ms":\s*[0-9]/);
});
