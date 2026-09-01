import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatP14cStatus, inspectP14cReadiness, validateP14cRecord } from './p14c-readiness.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readinessPath = path.join(repositoryRoot, 'docs', 'release', 'provider-readiness.json');

function currentRecord() {
  return JSON.parse(readFileSync(readinessPath, 'utf8'));
}

function currentPinQualifiedRecord() {
  const record = currentRecord();
  return {
    ...record,
    gates: record.gates.map((gate) =>
      gate.id === 'exact-pin-three-day-soak'
        ? {
            ...gate,
            status: 'waived',
            appliesToPin: record.targetPin,
            waivedBy: 'Test Maintainer',
            waivedOn: '2026-08-30',
            waiverKind: 'maintainer-authorized-skip',
          }
        : gate,
    ),
  };
}

test('the shipped record carries the maintainer-authorized exact-pin soak waiver', () => {
  const { record, blockers } = inspectP14cReadiness();
  assert.equal(record.cutoverAuthorized, true);
  assert.equal(record.defaultBackend, 'qmapi');
  assert.deepEqual(record.responsibilities.pendingProductionReplacement, []);
  assert.deepEqual(blockers, []);
  const soak = record.gates.find((gate) => gate.id === 'exact-pin-three-day-soak');
  assert.equal(soak.status, 'waived');
  assert.equal(soak.appliesToPin, record.targetPin);
  assert.equal(soak.waivedBy, 'Mai-xiyu');
  assert.equal(soak.waiverKind, 'maintainer-authorized-skip');
});

test('the shipped record renders a readable maintainer-waived report', () => {
  const { record, blockers } = inspectP14cReadiness();
  const report = formatP14cStatus(record, blockers);
  assert.match(report, /^PROVIDER READINESS STATUS: READY$/m);
  assert.match(report, /exact-pin-three-day-soak: waived/);
});

test('a waiver pinned to the cutover baseline blocks the current target pin', () => {
  const record = currentPinQualifiedRecord();
  const blockers = validateP14cRecord({
    ...record,
    gates: record.gates.map((gate) =>
      gate.id === 'exact-pin-three-day-soak'
        ? { ...gate, appliesToPin: record.cutoverBaselinePin }
        : gate,
    ),
  });
  assert.deepEqual(
    blockers.map((gate) => [gate.id, gate.blocker]),
    [['exact-pin-three-day-soak', 'target-pin-mismatch']],
  );
});

test('the baseline-pinned waiver renders a readable blocked report', () => {
  const record = currentPinQualifiedRecord();
  const staleRecord = {
    ...record,
    gates: record.gates.map((gate) =>
      gate.id === 'exact-pin-three-day-soak'
        ? { ...gate, appliesToPin: record.cutoverBaselinePin }
        : gate,
    ),
  };
  const blockers = validateP14cRecord(staleRecord);
  const report = formatP14cStatus(staleRecord, blockers);
  assert.match(report, /^PROVIDER READINESS STATUS: BLOCKED$/m);
  assert.match(report, /exact-pin-three-day-soak: blocked/);
  assert.match(report, /not target 006d149e59250122e77019e34a1a48340b20a1c3/);
});

test('a current-pin waiver produces a structurally ready fixture', () => {
  const record = currentPinQualifiedRecord();
  assert.deepEqual(validateP14cRecord(record), []);
  assert.deepEqual(
    record.gates.filter((gate) => gate.status === 'waived').map((gate) => gate.id),
    ['exact-pin-three-day-soak'],
  );
});

test('cutover authorization fails closed while any non-overlay gate is open', () => {
  const record = currentPinQualifiedRecord();
  assert.throws(
    () =>
      validateP14cRecord({
        ...record,
        cutoverAuthorized: true,
        gates: record.gates.map((gate) =>
          gate.id === 'retirement-scope' ? { ...gate, status: 'not-started' } : gate,
        ),
      }),
    /cannot be authorized/,
  );
});

test('the schema rejects unversioned gate identifiers', () => {
  const record = currentPinQualifiedRecord();
  assert.throws(
    () =>
      validateP14cRecord({
        ...record,
        gates: [
          ...record.gates,
          {
            id: 'extra-open-gate',
            status: 'not-started',
            evidence: 'docs/release/provider-readiness.md',
          },
        ],
      }),
    /unsupported provider readiness gate extra-open-gate/,
  );
});

test('a waived gate must carry non-empty waiver evidence', () => {
  const record = currentPinQualifiedRecord();
  assert.throws(
    () =>
      validateP14cRecord({
        ...record,
        gates: record.gates.map((gate) =>
          gate.id === 'exact-pin-three-day-soak' ? { ...gate, evidence: '' } : gate,
        ),
      }),
    /evidence for gate exact-pin-three-day-soak/,
  );
});

test('the exact-pin soak waiver cannot drift to a different dependency revision', () => {
  const record = currentPinQualifiedRecord();
  const blockers = validateP14cRecord({
    ...record,
    gates: record.gates.map((gate) =>
      gate.id === 'exact-pin-three-day-soak' ? { ...gate, appliesToPin: '0'.repeat(40) } : gate,
    ),
  });
  assert.deepEqual(
    blockers.map((gate) => [gate.id, gate.blocker]),
    [['exact-pin-three-day-soak', 'target-pin-mismatch']],
  );
});

test('the exact-pin soak gate is mandatory', () => {
  const record = currentPinQualifiedRecord();
  assert.throws(
    () =>
      validateP14cRecord({
        ...record,
        gates: record.gates.filter((gate) => gate.id !== 'exact-pin-three-day-soak'),
      }),
    /missing required gate exact-pin-three-day-soak/,
  );
});

test('changing the soak gate to pass cannot omit pin scope or evidence', () => {
  const record = currentPinQualifiedRecord();
  const passGate = record.gates.find((gate) => gate.id === 'exact-pin-three-day-soak');
  assert.throws(
    () =>
      validateP14cRecord({
        ...record,
        gates: record.gates.map((gate) =>
          gate.id === 'exact-pin-three-day-soak'
            ? { id: gate.id, status: 'pass', appliesToPin: passGate.appliesToPin }
            : gate,
        ),
      }),
    /evidence for gate exact-pin-three-day-soak/,
  );
  assert.throws(
    () =>
      validateP14cRecord({
        ...record,
        gates: record.gates.map((gate) =>
          gate.id === 'exact-pin-three-day-soak'
            ? { id: gate.id, status: 'pass', evidence: passGate.evidence }
            : gate,
        ),
      }),
    /target pin for gate exact-pin-three-day-soak/,
  );
});

test('changing a stale-pin waiver to pass does not bypass its stale pin scope', () => {
  const record = currentPinQualifiedRecord();
  const staleRecord = {
    ...record,
    gates: record.gates.map((gate) =>
      gate.id === 'exact-pin-three-day-soak'
        ? { ...gate, appliesToPin: record.cutoverBaselinePin }
        : gate,
    ),
  };
  const blockers = validateP14cRecord({
    ...staleRecord,
    gates: staleRecord.gates.map((gate) =>
      gate.id === 'exact-pin-three-day-soak' ? { ...gate, status: 'pass' } : gate,
    ),
  });
  assert.deepEqual(
    blockers.map((gate) => [gate.id, gate.blocker]),
    [['exact-pin-three-day-soak', 'target-pin-mismatch']],
  );
});

test('duplicate exact-pin soak gates are rejected', () => {
  const record = currentPinQualifiedRecord();
  const soakGate = record.gates.find((gate) => gate.id === 'exact-pin-three-day-soak');
  assert.throws(
    () => validateP14cRecord({ ...record, gates: [...record.gates, soakGate] }),
    /duplicate provider readiness gate/,
  );
});

test('unknown gate statuses and missing ordinary evidence fail schema validation', () => {
  const record = currentPinQualifiedRecord();
  assert.throws(
    () =>
      validateP14cRecord({
        ...record,
        gates: record.gates.map((gate) =>
          gate.id === 'retirement-scope' ? { ...gate, status: 'green' } : gate,
        ),
      }),
    /unsupported status green/,
  );
  assert.throws(
    () =>
      validateP14cRecord({
        ...record,
        gates: record.gates.map((gate) =>
          gate.id === 'retirement-scope' ? { ...gate, evidence: '' } : gate,
        ),
      }),
    /evidence for gate retirement-scope/,
  );
});

test('gate evidence must stay inside the repository and exist', () => {
  const record = currentPinQualifiedRecord();
  assert.throws(
    () =>
      validateP14cRecord({
        ...record,
        gates: record.gates.map((gate) =>
          gate.id === 'retirement-scope' ? { ...gate, evidence: '../outside.md' } : gate,
        ),
      }),
    /repository-relative docs\/release path/,
  );
  assert.throws(
    () =>
      validateP14cRecord({
        ...record,
        gates: record.gates.map((gate) =>
          gate.id === 'retirement-scope'
            ? { ...gate, evidence: 'docs/release/does-not-exist.md' }
            : gate,
        ),
      }),
    /does not exist/,
  );
});

test('a waiver requires maintainer identity, date, and an allowed waiver kind', () => {
  const record = currentPinQualifiedRecord();
  for (const [field, expected] of [
    ['waivedBy', /waivedBy/],
    ['waivedOn', /waivedOn/],
    ['waiverKind', /waiverKind/],
  ]) {
    assert.throws(
      () =>
        validateP14cRecord({
          ...record,
          gates: record.gates.map((gate) => {
            if (gate.id !== 'exact-pin-three-day-soak') return gate;
            const changed = { ...gate };
            delete changed[field];
            return changed;
          }),
        }),
      expected,
    );
  }
  assert.throws(
    () =>
      validateP14cRecord({
        ...record,
        gates: record.gates.map((gate) =>
          gate.id === 'exact-pin-three-day-soak' ? { ...gate, waiverKind: 'automatic' } : gate,
        ),
      }),
    /unsupported waiverKind automatic/,
  );
});

test('a waiver rejects an impossible calendar date', () => {
  const record = currentPinQualifiedRecord();
  const soak = record.gates.find(({ id }) => id === 'exact-pin-three-day-soak');
  soak.waivedOn = '2026-02-31';
  assert.throws(() => validateP14cRecord(record), /ISO calendar date/);
});

test('backend and cutover authorization cannot form a false READY state', () => {
  const record = currentPinQualifiedRecord();
  assert.throws(
    () => validateP14cRecord({ ...record, cutoverAuthorized: false }),
    /unauthorized provider cutover must keep the intree backend/i,
  );
  const blockers = validateP14cRecord({
    ...record,
    cutoverAuthorized: false,
    defaultBackend: 'intree',
  });
  assert.deepEqual(
    blockers.map((gate) => gate.id),
    ['cutover-authorization'],
  );
});

test('the legacy credential rollback slot remains explicit until cross-release retirement', () => {
  const record = currentPinQualifiedRecord();
  assert.ok(record.responsibilities.keep.includes('legacy-session-migration-rollback-slot'));
  assert.throws(
    () =>
      validateP14cRecord({
        ...record,
        responsibilities: {
          ...record.responsibilities,
          keep: record.responsibilities.keep.filter(
            (entry) => entry !== 'legacy-session-migration-rollback-slot',
          ),
        },
      }),
    /must retain legacy-session-migration-rollback-slot/,
  );
});
