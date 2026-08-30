import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  QM_API_RS_GIT,
  QM_API_RS_REV,
  assertProviderQmapiPin,
  checkAccess,
  isPinnedQqmusicApiPackage,
} from './qm-api-rs-access.mjs';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

test('pins the audited public production revision', () => {
  assert.equal(QM_API_RS_REV, 'bec1d0f245e36da0a8b052053d7b4dcb4893b90d');
  assert.equal(QM_API_RS_GIT, 'https://github.com/YAQMC/qm-api-rs.git');
});

test('current provider manifest pins unconditional qqmusic-api at the production revision', () => {
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
    /does not match the production pin/,
  );
});
