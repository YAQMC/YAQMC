import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AMLL_REV,
  AMLL_VERSION,
  CORRESPONDING_SOURCE_MANIFEST,
  createCorrespondingSourceBundle,
  parseCorrespondingSourceArgs,
} from './corresponding-source.mjs';
import { QM_API_RS_REV } from './qm-api-rs-access.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const YAQMC_REVISION = '1'.repeat(40);

function fakeGit(
  qmApiRsRoot,
  amllRoot,
  { qmRevision = QM_API_RS_REV, amllRevision = AMLL_REV } = {},
) {
  return (repository, args) => {
    if (args[0] === 'status') {
      return '';
    }
    if (args[0] === 'rev-parse') {
      const revision =
        repository === qmApiRsRoot
          ? qmRevision
          : repository === amllRoot
            ? amllRevision
            : YAQMC_REVISION;
      return `${revision}\n`;
    }
    if (args[0] === 'ls-tree') {
      if (repository === qmApiRsRoot) {
        return 'Cargo.toml\nCargo.lock\nLICENSE\nsrc/lib.rs\n';
      }
      if (repository === amllRoot) {
        return [
          'LICENSE',
          'package.json',
          'pnpm-lock.yaml',
          'packages/core/package.json',
          'packages/core/src/index.ts',
          'packages/react/package.json',
          'packages/react/src/index.ts',
        ].join('\n');
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
      if (repository === amllRoot) {
        const manifestPath = args[1].slice(args[1].indexOf(':') + 1);
        const name = manifestPath.includes('/core/')
          ? '@applemusic-like-lyrics/core'
          : '@applemusic-like-lyrics/react';
        return `${JSON.stringify({ name, version: AMLL_VERSION, license: 'AGPL-3.0-only' })}\n`;
      }
      return `tracked:${args[1]}\n`;
    }
    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };
}

test('parses explicit source checkout and output arguments', () => {
  assert.deepEqual(
    parseCorrespondingSourceArgs([
      '--qm-api-rs-root',
      'external/qm-api-rs',
      '--amll-root',
      'external/applemusic-like-lyrics',
      '--to',
      'source-out',
    ]),
    {
      'qm-api-rs-root': 'external/qm-api-rs',
      'amll-root': 'external/applemusic-like-lyrics',
      to: 'source-out',
    },
  );
  assert.throws(() => parseCorrespondingSourceArgs(['--to']), /requires a value/);
});

test('builds revision-bound source archives and a hash manifest', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-source-bundle-'));
  const qmApiRsRoot = path.join(scratch, 'qm-api-rs');
  const amllRoot = path.join(scratch, 'applemusic-like-lyrics');
  const outputDir = path.join(scratch, 'out');
  const result = createCorrespondingSourceBundle({
    yaqmcRoot: repositoryRoot,
    qmApiRsRoot,
    amllRoot,
    outputDir,
    runGit: fakeGit(qmApiRsRoot, amllRoot),
    runProvenanceGate: () => {},
  });

  assert.equal(result.manifest.releaseCommit, YAQMC_REVISION);
  assert.equal(result.manifest.qmApiRsRevision, QM_API_RS_REV);
  assert.equal(result.manifest.amll.revision, AMLL_REV);
  assert.equal(result.manifest.amll.version, AMLL_VERSION);
  assert.equal(result.manifest.p14c.status, 'BLOCKED');
  assert.deepEqual(result.manifest.p14c.blockers, ['exact-pin-three-day-soak']);
  assert.match(result.manifest.p14c.readinessSha256, /^[0-9a-f]{64}$/u);
  assert.equal(result.manifest.provenance.status, 'PASS');
  assert.match(result.manifest.provenance.ledgerSha256, /^[0-9a-f]{64}$/u);
  assert.equal(Object.keys(result.manifest.provenance.evidenceSha256).length, 2);
  assert.equal(result.manifest.components.length, 3);
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
  const amllRoot = path.join(scratch, 'applemusic-like-lyrics');
  const runGit = fakeGit(qmApiRsRoot, amllRoot);
  assert.throws(
    () =>
      createCorrespondingSourceBundle({
        yaqmcRoot: repositoryRoot,
        qmApiRsRoot,
        amllRoot,
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
  const amllRoot = path.join(scratch, 'applemusic-like-lyrics');
  assert.throws(
    () =>
      createCorrespondingSourceBundle({
        yaqmcRoot: repositoryRoot,
        qmApiRsRoot,
        amllRoot,
        outputDir: path.join(scratch, 'out'),
        runGit: fakeGit(qmApiRsRoot, amllRoot, { qmRevision: '2'.repeat(40) }),
        runProvenanceGate: () => {},
      }),
    /does not match the production pin/,
  );
});

test('rejects AMLL source that does not match the package revision', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-source-amll-pin-'));
  const qmApiRsRoot = path.join(scratch, 'qm-api-rs');
  const amllRoot = path.join(scratch, 'applemusic-like-lyrics');
  assert.throws(
    () =>
      createCorrespondingSourceBundle({
        yaqmcRoot: repositoryRoot,
        qmApiRsRoot,
        amllRoot,
        outputDir: path.join(scratch, 'out'),
        runGit: fakeGit(qmApiRsRoot, amllRoot, { amllRevision: '3'.repeat(40) }),
        runProvenanceGate: () => {},
      }),
    /does not match the package pin/,
  );
});
