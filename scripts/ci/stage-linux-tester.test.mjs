import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { repositoryRoot } from './repo.mjs';
import {
  LINUX_TESTER_STATIC_FILES,
  parseLinuxTesterArgs,
  stageLinuxTesterBundle,
} from './stage-linux-tester.mjs';
import { sha256File } from './write-build-info.mjs';

const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

function fakeGit(_root, args) {
  if (args.join(' ') === 'rev-parse HEAD') return COMMIT;
  if (args.join(' ') === 'rev-parse HEAD^{tree}') return TREE;
  throw new Error(`unexpected git args: ${args.join(' ')}`);
}

test('parses required Linux tester CLI values', () => {
  assert.deepEqual(parseLinuxTesterArgs(['--package-dir', 'packed', '--to', 'tester']), {
    'package-dir': 'packed',
    to: 'tester',
  });
  assert.throws(() => parseLinuxTesterArgs(['--to']), /requires a value/);
});

test('stages a flat revision-bound Linux tester artifact', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-linux-tester-'));
  const packageDir = path.join(scratch, 'package');
  const destination = path.join(scratch, 'tester');
  mkdirSync(packageDir);
  const appImageName = 'YAQMC-linux-x64.AppImage';
  writeFileSync(path.join(packageDir, appImageName), 'appimage');

  const result = stageLinuxTesterBundle({
    repositoryRoot,
    packageDir,
    destination,
    gitCommit: COMMIT,
    workflowRunId: '123',
    workflowRunAttempt: '2',
    runGit: fakeGit,
  });

  assert.deepEqual(result.files, [...LINUX_TESTER_STATIC_FILES, appImageName].sort());
  assert.equal(result.identity.gitCommit, COMMIT);
  assert.equal(result.identity.gitTree, TREE);
  assert.equal(result.identity.appImage.fileName, appImageName);
  assert.equal(result.identity.appImage.sha256, sha256File(path.join(destination, appImageName)));
  const sums = readFileSync(path.join(destination, 'SHA256SUMS'), 'utf8');
  for (const name of result.files.filter((name) => name !== 'SHA256SUMS')) {
    assert.match(sums, new RegExp(`  ${name.replaceAll('.', '\\.')}\\n`));
  }
});

test('rejects a requested commit that differs from the checkout', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-linux-tester-sha-'));
  const packageDir = path.join(scratch, 'package');
  mkdirSync(packageDir);
  writeFileSync(path.join(packageDir, 'YAQMC-linux-x64.AppImage'), 'appimage');
  assert.throws(
    () =>
      stageLinuxTesterBundle({
        repositoryRoot,
        packageDir,
        destination: path.join(scratch, 'tester'),
        gitCommit: 'c'.repeat(40),
        workflowRunId: '123',
        workflowRunAttempt: '1',
        runGit: fakeGit,
      }),
    /does not match checkout/,
  );
});
