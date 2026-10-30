import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkLocalRelease } from '../check-local-release.mjs';

const commit = 'a'.repeat(40);
function fixture({ status = () => '', head = () => commit, gate = () => {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-local-release-'));
  for (const [file, content] of Object.entries({
    'package.json': '{"version":"1.2.3-beta.1"}',
    'apps/desktop/package.json': '{"version":"1.2.3-beta.1"}',
    'apps/android/package.json': '{"version":"1.2.3-beta.1"}',
    'Cargo.toml': '[workspace]\nmembers = ["crates/test"]\n',
    'crates/test/Cargo.toml': '[package]\nname = "test"\nversion = "1.2.3-beta.1"\n',
    'docs/release/provenance-ledger.json': '{}',
    'docs/release/provider-readiness.json': '{}',
  })) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  const calls = [];
  const run = (command, args) => {
    if (command === 'git') return args[0] === 'rev-parse' ? head() : status();
    calls.push(args);
    gate(args);
    return '';
  };
  return { root, run, calls };
}

test('local release checks bind both private gates to a clean exact version and commit', () => {
  const f = fixture();
  assert.deepEqual(checkLocalRelease({ ...f, commit, tag: 'v1.2.3-beta.1' }), {
    commit,
    tag: 'v1.2.3-beta.1',
  });
  assert.deepEqual(f.calls, [
    ['scripts/validate-provenance-ledger.mjs', '--enforce'],
    ['scripts/ci/p14c-readiness.mjs', '--enforce'],
  ]);
});

test('missing private inputs, dirty source, version drift and stale commits cannot approve a release', () => {
  assert.throws(() => checkLocalRelease({ ...fixture(), commit: 'b'.repeat(40) }), /match.*HEAD/u);
  assert.throws(
    () => checkLocalRelease(fixture({ status: () => ' M src/file' })),
    /tracked source/u,
  );
  assert.throws(() => checkLocalRelease({ ...fixture(), tag: 'v1.2.3' }), /canonical version/u);
  const missing = fixture();
  unlinkSync(path.join(missing.root, 'docs/release/provenance-ledger.json'));
  assert.throws(() => checkLocalRelease(missing), /ENOENT/u);
  assert.equal(missing.calls.length, 0);
  const mismatch = fixture();
  writeFileSync(path.join(mismatch.root, 'apps/desktop/package.json'), '{"version":"1.2.2"}');
  assert.throws(() => checkLocalRelease(mismatch), /version mismatch/u);
});

test('gate failures and source changes during checking never produce approval', () => {
  assert.throws(
    () =>
      checkLocalRelease(
        fixture({
          gate: () => {
            throw new Error('synthetic gate blocked');
          },
        }),
      ),
    /gate blocked/u,
  );
  let reads = 0;
  assert.throws(
    () => checkLocalRelease(fixture({ status: () => (reads++ ? ' M src/file' : '') })),
    /Source changed/u,
  );
  let revisions = 0;
  assert.throws(
    () => checkLocalRelease(fixture({ head: () => (revisions++ ? 'b'.repeat(40) : commit) })),
    /Source changed/u,
  );
});
