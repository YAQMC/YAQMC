import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CORRESPONDING_SOURCE_MANIFEST,
  createCorrespondingSourceBundle,
  parseCorrespondingSourceArgs,
} from './corresponding-source.mjs';
import { QM_API_RS_REV } from './qm-api-rs-access.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const YAQMC_REVISION = '1'.repeat(40);

function fakeGit(qmApiRsRoot, qmRevision = QM_API_RS_REV) {
  return (repository, args) => {
    if (args[0] === 'status') {
      return '';
    }
    if (args[0] === 'rev-parse') {
      return `${repository === qmApiRsRoot ? qmRevision : YAQMC_REVISION}\n`;
    }
    if (args[0] === 'ls-tree') {
      if (repository === qmApiRsRoot) {
        return 'Cargo.toml\nCargo.lock\nLICENSE\nsrc/lib.rs\n';
      }
      return [
        '.github/workflows/electron-release.yml',
        'Cargo.lock',
        'Cargo.toml',
        'LICENSE',
        'package-lock.json',
        'package.json',
      ].join('\n');
    }
    if (args[0] === 'archive') {
      const output = args.find((arg) => arg.startsWith('--output=')).slice('--output='.length);
      writeFileSync(output, `archive:${repository}:${args.at(-1)}\n`);
      return '';
    }
    if (args[0] === 'show') {
      return `tracked:${args[1]}\n`;
    }
    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };
}

test('parses explicit source checkout and output arguments', () => {
  assert.deepEqual(
    parseCorrespondingSourceArgs(['--qm-api-rs-root', 'external/qm-api-rs', '--to', 'source-out']),
    { 'qm-api-rs-root': 'external/qm-api-rs', to: 'source-out' },
  );
  assert.throws(() => parseCorrespondingSourceArgs(['--to']), /requires a value/);
});

test('builds revision-bound source archives and a hash manifest', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-source-bundle-'));
  const qmApiRsRoot = path.join(scratch, 'qm-api-rs');
  const outputDir = path.join(scratch, 'out');
  const result = createCorrespondingSourceBundle({
    yaqmcRoot: repositoryRoot,
    qmApiRsRoot,
    outputDir,
    runGit: fakeGit(qmApiRsRoot),
    runProvenanceGate: () => {},
  });

  assert.equal(result.manifest.releaseCommit, YAQMC_REVISION);
  assert.equal(result.manifest.qmApiRsRevision, QM_API_RS_REV);
  assert.equal(result.manifest.p14c.status, 'READY');
  assert.match(result.manifest.p14c.readinessSha256, /^[0-9a-f]{64}$/u);
  assert.equal(result.manifest.provenance.status, 'PASS');
  assert.match(result.manifest.provenance.ledgerSha256, /^[0-9a-f]{64}$/u);
  assert.equal(Object.keys(result.manifest.provenance.evidenceSha256).length, 2);
  assert.equal(result.manifest.components.length, 2);
  for (const component of result.manifest.components) {
    assert.match(component.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(existsSync(path.join(outputDir, component.archive)));
  }
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(outputDir, CORRESPONDING_SOURCE_MANIFEST), 'utf8')),
    result.manifest,
  );
});

test('rejects dirty source checkouts before reading mutable worktree metadata', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-source-dirty-'));
  const qmApiRsRoot = path.join(scratch, 'qm-api-rs');
  const runGit = fakeGit(qmApiRsRoot);
  assert.throws(
    () =>
      createCorrespondingSourceBundle({
        yaqmcRoot: repositoryRoot,
        qmApiRsRoot,
        outputDir: path.join(scratch, 'out'),
        runGit: (repository, args) =>
          args[0] === 'status' && repository === repositoryRoot
            ? ' M docs/release/provider-readiness.json\n'
            : runGit(repository, args),
        runProvenanceGate: () => {},
      }),
    /requires a clean checkout/,
  );
});

test('rejects source that does not match the unconditional production pin', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-source-pin-'));
  const qmApiRsRoot = path.join(scratch, 'qm-api-rs');
  assert.throws(
    () =>
      createCorrespondingSourceBundle({
        yaqmcRoot: repositoryRoot,
        qmApiRsRoot,
        outputDir: path.join(scratch, 'out'),
        runGit: fakeGit(qmApiRsRoot, '2'.repeat(40)),
        runProvenanceGate: () => {},
      }),
    /does not match the production pin/,
  );
});
