import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const validator = path.join(repositoryRoot, 'scripts', 'validate-provenance-ledger.mjs');
const committedLedger = path.join(repositoryRoot, 'docs', 'migration', 'provenance-ledger.json');
const revision = '0123456789abcdef0123456789abcdef01234567';

function passingLedger() {
  return {
    schemaVersion: 1,
    audit: {
      repository: {
        auditHead: revision,
        historicalBase: { commit: revision, commitCount: 1 },
      },
      qmApiRs: { revision },
    },
    sources: [
      {
        id: 'fixture-source',
        origin: 'https://example.invalid/source',
        revision,
        license: 'MIT',
        status: 'verified',
        mappings: [{ target: 'src/example.rs', relation: 'implemented' }],
        evidence: [`git-object:${revision}`],
        authorization: { status: 'not-required' },
      },
    ],
    contributors: [
      {
        id: 'fixture-author',
        name: 'Fixture Author',
        consentStatus: 'verified',
        rightsScope: 'fixture content',
        evidence: `signed-commit:${revision}`,
      },
    ],
    assets: [
      {
        id: 'fixture-asset',
        path: 'assets/example.txt',
        sourceId: 'fixture-source',
        status: 'verified',
        evidence: `sha256:${'a'.repeat(64)}`,
      },
    ],
    release: { decision: 'pass', blockers: [] },
  };
}

function writeFixture(ledger) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-provenance-ledger-'));
  const ledgerPath = path.join(directory, 'ledger.json');
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return ledgerPath;
}

function runLedger(ledgerPath, enforce = false) {
  return spawnSync(
    process.execPath,
    [validator, '--ledger', ledgerPath, ...(enforce ? ['--enforce'] : [])],
    {
      encoding: 'utf8',
    },
  );
}

test('committed ledger reports PASS and enforcement succeeds', () => {
  const report = runLedger(committedLedger);

  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /PROVENANCE STATUS: PASS/);
  assert.match(report.stdout, /release decision: pass/);

  const enforced = runLedger(committedLedger, true);
  assert.equal(enforced.status, 0, enforced.stderr);
  assert.match(enforced.stdout, /PROVENANCE STATUS: PASS/);
});

test('clean fixture passes enforcement only with typed immutable evidence references', () => {
  const enforced = runLedger(writeFixture(passingLedger()), true);

  assert.equal(enforced.status, 0, enforced.stderr);
  assert.match(enforced.stdout, /PROVENANCE STATUS: PASS/);
});

test('rejects fabricated or ordinary evidence strings as immutable proof', () => {
  const ledger = passingLedger();
  ledger.sources[0].evidence = ['fake'];
  ledger.sources[0].kind = 'proprietary-client-extraction';
  ledger.sources[0].authorization = {
    status: 'verified',
    evidence: 'https://example.invalid/plain-url',
  };
  ledger.contributors[0].evidence = 'arbitrary evidence';
  ledger.assets[0].evidence = 'fake';

  const enforced = runLedger(writeFixture(ledger), true);

  assert.notEqual(enforced.status, 0);
  assert.match(enforced.stdout, /PROVENANCE STATUS: BLOCKED/);
  assert.match(enforced.stdout, /revision-bound immutable evidence/);
  assert.match(enforced.stdout, /typed immutable authorization evidence/);
  assert.match(enforced.stdout, /verified consent lacks typed immutable evidence/);
  assert.match(enforced.stdout, /verified status lacks typed immutable evidence/);
});

test('rejects a revision URL with the right SHA but an unrelated source origin', () => {
  const ledger = passingLedger();
  ledger.sources[0].origin = 'https://github.com/legitimate-owner/repo';
  ledger.sources[0].evidence = [
    `git-revision-url:https://example.invalid/arbitrary/${revision}/LICENSE`,
  ];

  const enforced = runLedger(writeFixture(ledger), true);

  assert.notEqual(enforced.status, 0);
  assert.match(enforced.stdout, /PROVENANCE STATUS: BLOCKED/);
  assert.match(enforced.stdout, /revision-bound immutable evidence/);
});

test('rejects a revision URL on the same host but from another repository', () => {
  const ledger = passingLedger();
  ledger.sources[0].origin = 'https://github.com/legitimate-owner/repo';
  ledger.sources[0].evidence = [
    `git-revision-url:https://github.com/arbitrary-owner/other-repo/blob/${revision}/LICENSE`,
  ];

  const enforced = runLedger(writeFixture(ledger), true);

  assert.notEqual(enforced.status, 0);
  assert.match(enforced.stdout, /PROVENANCE STATUS: BLOCKED/);
  assert.match(enforced.stdout, /revision-bound immutable evidence/);
});

test('accepts a revision URL from a normalized source repository origin', () => {
  const ledger = passingLedger();
  ledger.sources[0].origin = 'https://github.com/legitimate-owner/repo.git/';
  ledger.sources[0].evidence = [
    `git-revision-url:https://github.com/legitimate-owner/repo/blob/${revision}/LICENSE`,
  ];

  const enforced = runLedger(writeFixture(ledger), true);

  assert.equal(enforced.status, 0, enforced.stderr);
  assert.match(enforced.stdout, /PROVENANCE STATUS: PASS/);
});

test('license, revision, mapping, proprietary authorization, and contributor consent failures cannot pass', () => {
  const cases = [
    {
      label: 'NOASSERTION license',
      mutate: (ledger) => {
        ledger.sources[0].license = 'NOASSERTION';
      },
      expected: /license=NOASSERTION/,
    },
    {
      label: 'unknown revision',
      mutate: (ledger) => {
        ledger.sources[0].revision = null;
      },
      expected: /immutable revision is missing or invalid/,
    },
    {
      label: 'unmapped source',
      mutate: (ledger) => {
        ledger.sources[0].mappings = [];
      },
      expected: /has no target mapping/,
    },
    {
      label: 'verified source without immutable evidence',
      mutate: (ledger) => {
        ledger.sources[0].evidence = [];
      },
      expected: /verified status lacks revision-bound immutable evidence/,
    },
    {
      label: 'proprietary extraction without authorization',
      mutate: (ledger) => {
        ledger.sources[0].kind = 'proprietary-client-extraction';
        ledger.sources[0].authorization = { status: 'missing' };
      },
      expected: /proprietary-client-extraction lacks typed immutable authorization evidence/,
    },
    {
      label: 'pending contributor consent',
      mutate: (ledger) => {
        ledger.contributors[0].consentStatus = 'pending';
      },
      expected: /contributor:fixture-author consentStatus=pending/,
    },
    {
      label: 'verified contributor without evidence',
      mutate: (ledger) => {
        ledger.contributors[0].evidence = null;
      },
      expected: /contributor:fixture-author verified consent lacks typed immutable evidence/,
    },
    {
      label: 'verified asset without evidence',
      mutate: (ledger) => {
        ledger.assets[0].evidence = '';
      },
      expected: /asset:fixture-asset verified status lacks typed immutable evidence/,
    },
  ];

  for (const { label, mutate, expected } of cases) {
    const ledger = passingLedger();
    mutate(ledger);
    const ledgerPath = writeFixture(ledger);
    const report = runLedger(ledgerPath);
    const enforced = runLedger(ledgerPath, true);

    assert.equal(report.status, 0, `${label}: ${report.stderr}`);
    assert.match(report.stdout, /PROVENANCE STATUS: BLOCKED/, label);
    assert.match(report.stdout, expected, label);
    assert.notEqual(enforced.status, 0, label);
  }
});

test('rejects empty source, contributor, or asset coverage structurally', () => {
  for (const field of ['sources', 'contributors', 'assets']) {
    const ledger = passingLedger();
    ledger[field] = [];
    const result = runLedger(writeFixture(ledger));

    assert.equal(result.status, 2, field);
    assert.match(result.stderr, new RegExp(`${field} coverage must not be empty`));
  }
});
