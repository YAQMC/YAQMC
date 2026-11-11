import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
test('API export targets a companion checkout and verifies generated mirrors', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const out = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-api-export-'));
  const run = (...args) =>
    execFileSync(process.execPath, ['scripts/sync-plugin-example.mjs', '--out', out, ...args], {
      cwd: root,
    });
  run();
  run('--check');
  assert.match(readFileSync(path.join(out, 'plugins/starter/API.md'), 'utf8'), /ui\.lyrics/);
  assert.equal(
    readFileSync(path.join(out, 'sdk/plugin/src/index.ts'), 'utf8'),
    readFileSync(path.join(out, 'plugins/starter/api/sdk.ts'), 'utf8'),
  );
});
