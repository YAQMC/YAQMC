import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  QM_API_RS_GIT,
  QM_API_RS_REV,
  QM_API_RS_TOKEN_ENV,
  assertProviderQmapiPin,
  checkAccess,
  configureGitInsteadOf,
  gitInsteadOfArgs,
  isPinnedQqmusicApiPackage,
  sanitizeAccessToken,
} from './qm-api-rs-access.mjs';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

test('pins the audited private revision and refuses a dirty token', () => {
  assert.equal(QM_API_RS_REV, '476b37e3135560dff132e9ba8996e068af706458');
  assert.equal(QM_API_RS_GIT, 'https://github.com/YAQMC/qm-api-rs.git');
  assert.equal(sanitizeAccessToken(''), '');
  assert.throws(() => sanitizeAccessToken('abc@def'), /cannot be used/);
  assert.deepEqual(gitInsteadOfArgs('test-token'), [
    'config',
    '--global',
    'url.https://x-access-token:test-token@github.com/YAQMC/qm-api-rs.insteadOf',
    QM_API_RS_GIT,
  ]);
});

test('refuses to write git config unless CI explicitly opts in', () => {
  assert.throws(
    () => configureGitInsteadOf({ env: { [QM_API_RS_TOKEN_ENV]: 'test-token' } }),
    /refusing to write git config/,
  );
  const skipped = configureGitInsteadOf({ env: { CI: 'true' } });
  assert.equal(skipped.configured, false);
  assert.match(skipped.reason, /unset/);
});

test('configures insteadOf without echoing the token through the git argv helper', () => {
  const calls = [];
  const result = configureGitInsteadOf({
    env: { CI: 'true', [QM_API_RS_TOKEN_ENV]: 'test-token' },
    runGit: (command, args) => {
      calls.push([command, args]);
      return '';
    },
  });
  assert.equal(result.configured, true);
  assert.equal(result.insteadOf, QM_API_RS_GIT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'git');
  assert.doesNotMatch(
    JSON.stringify(calls[0][1].filter((part) => part !== calls[0][1][2])),
    /test-token/,
  );
  assert.match(calls[0][1][2], /x-access-token:test-token@github.com\/YAQMC\/qm-api-rs/);
});

test('current provider manifest pins unconditional qqmusic-api at the P14 rev', () => {
  const checked = checkAccess({
    root: repositoryRoot,
    sibling: path.join(os.tmpdir(), 'yaqmc-no-qm-api-rs-checkout'),
  });
  assert.equal(checked.linked, 'required');
  assert.equal(checked.rev, QM_API_RS_REV);
  assert.equal(checked.siblingRevision, null);
  assert.throws(
    () =>
      assertProviderQmapiPin(`
default = ["qmapi"]
qmapi = ["dep:qqmusic-api"]
qqmusic-api = { git = "${QM_API_RS_GIT}", rev = "${QM_API_RS_REV}" }
`),
    /default features must be empty/,
  );
  assert.throws(
    () =>
      assertProviderQmapiPin(`
default = []
qmapi = ["dep:qqmusic-api"]
qqmusic-api = { git = "${QM_API_RS_GIT}", rev = "${QM_API_RS_REV}" }
`),
    /backend feature split must be removed/,
  );
  assert.throws(
    () =>
      assertProviderQmapiPin(`
default = []
qqmusic-api = { git = "${QM_API_RS_GIT}", rev = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", optional = true }
`),
    /must pin rev/,
  );
  assert.ok(
    isPinnedQqmusicApiPackage({
      name: 'qqmusic-api',
      id: `git+${QM_API_RS_GIT}?rev=${QM_API_RS_REV}#qqmusic-api@0.1.0`,
    }),
  );
  assert.equal(
    isPinnedQqmusicApiPackage({
      name: 'qqmusic-api',
      id: 'git+https://github.com/YAQMC/qm-api-rs.git?rev=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef#qqmusic-api@0.1.0',
    }),
    false,
  );
});

test('a sibling checkout at the pin is accepted', () => {
  const checked = checkAccess({
    root: repositoryRoot,
    siblingRevision: QM_API_RS_REV,
  });
  assert.equal(checked.linked, 'required');
  assert.equal(checked.siblingRevision, QM_API_RS_REV);
});

test('a sibling checkout at the wrong revision fails closed', () => {
  assert.throws(
    () =>
      checkAccess({
        root: repositoryRoot,
        siblingRevision: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      }),
    /does not match the P14 pin/,
  );
});
