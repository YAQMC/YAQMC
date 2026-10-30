import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrivateReleaseFile } from './private-release-files.mjs';

test('private reports are excluded from each component source archive', () => {
  for (const file of [
    'PROVENANCE.md',
    'AUDIT_REPORT_2026.md',
    'audit-report-old.md',
    'release-report.md',
    'docs/release/provenance-ledger.json',
    'docs/release/provider-readiness.md',
    'docs/migration/provenance-audit.md',
    'audit-reports/log.md',
    'output/test.log',
    '.agent-briefs/task.md',
    'artifacts/soak-last.json',
  ]) {
    assert.equal(isPrivateReleaseFile(file), true, file);
    assert.equal(isPrivateReleaseFile(file.replaceAll('/', '\\')), true, file);
  }
  for (const file of [
    'LICENSE',
    'COPYING',
    'THIRD_PARTY_NOTICES.md',
    'LICENSING_CONSENT.md',
    'docs/release/licensing-consent-record.json',
    'docs/release/README.md',
    'src/main.rs',
    'scripts/ci/p14c-readiness.test.mjs',
  ])
    assert.equal(isPrivateReleaseFile(file), false, file);
});
