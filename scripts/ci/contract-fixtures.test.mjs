import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FIXTURE_FILES,
  assertFixturesMatch,
  committedFixturesDir,
  readFixture,
} from '../update-contract-fixtures.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function methodNamesFromClient() {
  const source = readFileSync(
    path.join(repositoryRoot, 'packages/yaqmc-client/src/protocol/methods.ts'),
    'utf8',
  );
  const block = (name) => {
    const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
    assert.ok(match, name);
    return [...match[1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map((entry) => entry[1]);
  };
  return [...block('MIGRATED_METHOD_NAMES'), ...block('PROTOCOL_ONLY_METHODS')];
}

test('committed contract fixtures exist and stay under the 32 MiB hard cap', () => {
  const dir = committedFixturesDir(repositoryRoot);
  for (const name of FIXTURE_FILES) {
    readFileSync(path.join(dir, name), 'utf8');
  }
  const constants = readFixture(dir, 'constants.json');
  assert.equal(constants.protocolVersion, 1);
  assert.equal(constants.frameHardCapBytes, 32 * 1024 * 1024);
  assert.equal(constants.defaultMethodPayloadBytes, 1024 * 1024);
});

test('committed method fixtures match the TypeScript protocol mirror', () => {
  const rows = readFixture(committedFixturesDir(repositoryRoot), 'methods.json');
  assert.deepEqual(
    rows.map((row) => row.name),
    methodNamesFromClient(),
  );
  for (const row of rows) {
    assert.ok(row.requestCap <= 32 * 1024 * 1024, row.name);
    assert.ok(row.responseCap <= 32 * 1024 * 1024, row.name);
  }
});

test('fixture drift comparison ignores platform line endings only', (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-contract-lines-'));
  const left = path.join(root, 'left');
  const right = path.join(root, 'right');
  mkdirSync(left);
  mkdirSync(right);
  context.after(() => rmSync(root, { force: true, recursive: true }));

  for (const name of FIXTURE_FILES) {
    writeFileSync(path.join(left, name), '{\r\n  "value": 1\r\n}\r\n', 'utf8');
    writeFileSync(path.join(right, name), '{\n  "value": 1\n}\n', 'utf8');
  }

  assert.doesNotThrow(() => assertFixturesMatch(left, right));
});
