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
        evidence: ['https://example.invalid/source-evidence'],
        authorization: { status: 'not-required' },
      },
    ],
    contributors: [
      {
        id: 'fixture-author',
        name: 'Fixture Author',
        consentStatus: 'verified',
        rightsScope: 'fixture content',
        evidence: 'https://example.invalid/contributor',
      },
    ],
    assets: [
      {
        id: 'fixture-asset',
        path: 'assets/example.txt',
        sourceId: 'fixture-source',
        status: 'verified',
        evidence: 'https://example.invalid/asset',
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

test('committed ledger reports BLOCKED without treating its unresolved rights as a parser failure', () => {
  const report = runLedger(committedLedger);

  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /PROVENANCE STATUS: BLOCKED/);
  assert.match(report.stdout, /release decision: block/);
  assert.match(report.stdout, /proprietary-client-extraction/);
});

test('enforcement rejects the committed ledger while its audit remains blocked', () => {
  const enforced = runLedger(committedLedger, true);

  assert.notEqual(enforced.status, 0);
  assert.match(enforced.stdout, /PROVENANCE STATUS: BLOCKED/);
  assert.match(enforced.stderr, /enforcement failed/i);
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
      expected: /verified status lacks immutable evidence/,
    },
    {
      label: 'proprietary extraction without authorization',
      mutate: (ledger) => {
        ledger.sources[0].kind = 'proprietary-client-extraction';
        ledger.sources[0].authorization = { status: 'missing' };
      },
      expected: /proprietary-client-extraction lacks verified authorization/,
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
      expected: /contributor:fixture-author verified consent lacks immutable evidence/,
    },
    {
      label: 'verified asset without evidence',
      mutate: (ledger) => {
        ledger.assets[0].evidence = '';
      },
      expected: /asset:fixture-asset verified status lacks immutable evidence/,
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
