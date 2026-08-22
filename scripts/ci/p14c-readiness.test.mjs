import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatP14cStatus, inspectP14cReadiness, validateP14cRecord } from './p14c-readiness.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readinessPath = path.join(repositoryRoot, 'docs', 'migration', 'p14c-readiness.json');

function currentRecord() {
  return JSON.parse(readFileSync(readinessPath, 'utf8'));
}

function currentPinQualifiedRecord() {
  const record = currentRecord();
  return {
    ...record,
    gates: record.gates.map((gate) =>
      gate.id === 'exact-pin-three-day-soak' ? { ...gate, appliesToPin: record.targetPin } : gate,
    ),
  };
}

test('the shipped record carries the current-pin waiver and has no blockers', () => {
  const { record, blockers } = inspectP14cReadiness();
  assert.equal(record.cutoverAuthorized, true);
  assert.equal(record.defaultBackend, 'qmapi');
  assert.deepEqual(record.responsibilities.pendingProductionReplacement, []);
  assert.deepEqual(blockers, []);
  assert.deepEqual(
    record.gates.filter((gate) => gate.status === 'waived').map((gate) => gate.appliesToPin),
    [record.targetPin],
  );
});

test('the shipped record renders a readable ready report', () => {
  const { record, blockers } = inspectP14cReadiness();
  const report = formatP14cStatus(record, blockers);
  assert.match(report, /^P14-C STATUS: READY$/m);
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
  assert.match(report, /^P14-C STATUS: BLOCKED$/m);
  assert.match(report, /exact-pin-three-day-soak: blocked/);
  assert.match(report, /not target 476b37e3135560dff132e9ba8996e068af706458/);
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
        gates: [...record.gates, { id: 'extra-open-gate', status: 'not-started', evidence: null }],
      }),
    /cannot be authorized/,
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
    /must contain exactly one exact-pin-three-day-soak gate/,
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
    /duplicate P14-C gate/,
  );
});
