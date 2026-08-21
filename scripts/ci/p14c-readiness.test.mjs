import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectP14cReadiness, validateP14cRecord } from './p14c-readiness.mjs';

test('current P14-C preparation is guarded and reports the open gates', () => {
  const { record, blockers } = inspectP14cReadiness();
  assert.equal(record.cutoverAuthorized, false);
  assert.equal(record.defaultBackend, 'intree');
  assert.deepEqual(record.responsibilities.pendingProductionReplacement, ['intree-qmc-decrypt']);
  assert.deepEqual(
    blockers.map((gate) => gate.id),
    ['exact-pin-three-day-soak'],
  );
});

test('cutover authorization fails closed while any gate is open', () => {
  const { record } = inspectP14cReadiness();
  assert.throws(
    () => validateP14cRecord({ ...record, cutoverAuthorized: true }),
    /cannot be authorized/,
  );
});

test('duplicate readiness gates are rejected', () => {
  const { record } = inspectP14cReadiness();
  assert.throws(
    () => validateP14cRecord({ ...record, gates: [...record.gates, record.gates[0]] }),
    /duplicate P14-C gate/,
  );
});
