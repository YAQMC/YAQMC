import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectP14cReadiness, validateP14cRecord } from './p14c-readiness.mjs';

test('P14-C cutover is authorized and only the waived soak remains visible', () => {
  const { record, blockers } = inspectP14cReadiness();
  assert.equal(record.cutoverAuthorized, true);
  assert.equal(record.defaultBackend, 'qmapi');
  assert.deepEqual(record.responsibilities.pendingProductionReplacement, []);
  assert.deepEqual(blockers, []);
  assert.deepEqual(
    record.gates.filter((gate) => gate.status === 'waived').map((gate) => gate.id),
    ['exact-pin-three-day-soak'],
  );
});

test('cutover authorization fails closed while any gate is open', () => {
  const { record } = inspectP14cReadiness();
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
  const { record } = inspectP14cReadiness();
  assert.throws(
    () =>
      validateP14cRecord({
        ...record,
        gates: record.gates.map((gate) =>
          gate.id === 'exact-pin-three-day-soak' ? { ...gate, evidence: '' } : gate,
        ),
      }),
    /waiver evidence/,
  );
});

test('duplicate readiness gates are rejected', () => {
  const { record } = inspectP14cReadiness();
  assert.throws(
    () => validateP14cRecord({ ...record, gates: [...record.gates, record.gates[0]] }),
    /duplicate P14-C gate/,
  );
});
