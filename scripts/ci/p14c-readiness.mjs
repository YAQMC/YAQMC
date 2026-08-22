import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QM_API_RS_REV } from './qm-api-rs-access.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exactPinSoakGateId = 'exact-pin-three-day-soak';
const immutableRevision = /^[0-9a-f]{40}$/u;

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

export function validateP14cRecord(record) {
  if (record?.schemaVersion !== 1 || record?.phase !== 'P14-C') {
    throw new Error('P14-C readiness record has an unsupported schema or phase');
  }
  if (record.targetPin !== QM_API_RS_REV) {
    throw new Error(`P14-C target pin must match ${QM_API_RS_REV}`);
  }
  requireString(record.cutoverBaselinePin, 'P14-C cutover baseline pin');
  if (!immutableRevision.test(record.cutoverBaselinePin)) {
    throw new Error('P14-C cutover baseline pin must be an immutable 40-character SHA');
  }
  if (!Array.isArray(record.gates) || record.gates.length === 0) {
    throw new Error('P14-C readiness record must contain gates');
  }

  const ids = new Set();
  for (const gate of record.gates) {
    requireString(gate?.id, 'gate id');
    requireString(gate?.status, `gate ${gate.id} status`);
    if (ids.has(gate.id)) throw new Error(`duplicate P14-C gate: ${gate.id}`);
    ids.add(gate.id);
  }

  const exactPinSoakGates = record.gates.filter((gate) => gate.id === exactPinSoakGateId);
  if (exactPinSoakGates.length !== 1) {
    throw new Error(`P14-C readiness record must contain exactly one ${exactPinSoakGateId} gate`);
  }
  const [exactPinSoakGate] = exactPinSoakGates;
  requireString(exactPinSoakGate.evidence, `evidence for gate ${exactPinSoakGateId}`);
  requireString(exactPinSoakGate.appliesToPin, `target pin for gate ${exactPinSoakGateId}`);

  for (const name of ['retireAfterGates', 'keep']) {
    const entries = record.responsibilities?.[name];
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`P14-C responsibilities.${name} must be a non-empty array`);
    }
    if (entries.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      throw new Error(`P14-C responsibilities.${name} contains an invalid entry`);
    }
  }
  const pending = record.responsibilities?.pendingProductionReplacement;
  if (!Array.isArray(pending)) {
    throw new Error('P14-C responsibilities.pendingProductionReplacement must be an array');
  }
  if (pending.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(
      'P14-C responsibilities.pendingProductionReplacement contains an invalid entry',
    );
  }

  const blockers = record.gates.filter(
    (gate) => gate.status !== 'pass' && gate.status !== 'waived',
  );
  for (const gate of record.gates.filter((gate) => gate.status === 'waived')) {
    requireString(gate?.evidence, `waiver evidence for gate ${gate.id}`);
  }
  if (exactPinSoakGate.appliesToPin !== record.targetPin) {
    const mismatch = {
      ...exactPinSoakGate,
      status: 'blocked',
      blocker: 'target-pin-mismatch',
      reason: `applies to ${exactPinSoakGate.appliesToPin}, not target ${record.targetPin}`,
    };
    const existingIndex = blockers.findIndex((gate) => gate.id === exactPinSoakGateId);
    if (existingIndex === -1) blockers.push(mismatch);
    else blockers[existingIndex] = mismatch;
  }

  const reviewingAPostCutoverPin =
    record.cutoverAuthorized && record.targetPin !== record.cutoverBaselinePin;
  const historicalCutoverBlockers = reviewingAPostCutoverPin
    ? blockers.filter((gate) => gate.id !== exactPinSoakGateId)
    : blockers;
  if (record.cutoverAuthorized && historicalCutoverBlockers.length > 0) {
    throw new Error('P14-C cutover cannot be authorized while gates are open');
  }
  return blockers;
}

export function assertP14cPreparationGuards({
  record,
  providerManifest,
  coreManifest,
  qmcSource,
  authSource,
  credentialSource,
  accountSource,
}) {
  const blockers = validateP14cRecord(record);
  const reviewingAPostCutoverPin =
    record.cutoverAuthorized && record.targetPin !== record.cutoverBaselinePin;
  const preparationBlockers = reviewingAPostCutoverPin
    ? blockers.filter((gate) => gate.id !== exactPinSoakGateId)
    : blockers;
  if (preparationBlockers.length > 0 && record.defaultBackend !== 'intree') {
    throw new Error('P14-C default backend must remain intree while gates are open');
  }
  if (!/^default\s*=\s*\[\]$/m.test(providerManifest)) {
    throw new Error('provider must have empty default features after the P14-C cutover');
  }
  if (
    !/^qqmusic-api\s*=\s*\{[^\n]*git\s*=\s*"[^"]+"[^\n]*rev\s*=\s*"[^"]+"[^\n]*\}$/m.test(
      providerManifest,
    ) ||
    /^qqmusic-api\s*=\s*\{[^\n]*optional\s*=\s*true[^\n]*\}$/m.test(providerManifest)
  ) {
    throw new Error('qqmusic-api must be an unconditional git pin after the P14-C cutover');
  }
  if (/^qqmusic-qmapi\s*=\s*\[/m.test(coreManifest)) {
    throw new Error('Core must drop the qqmusic-qmapi opt-in after the P14-C cutover');
  }
  if (!qmcSource.includes('QmapiQmcDecryptor::new(self)')) {
    throw new Error('production QMC routing no longer points at the library adapter');
  }
  if (!authSource.includes('pub(crate) const ACTIVE_SESSION: &str = "qqmusic-session";')) {
    throw new Error('legacy credential fallback was removed before credential-v2 became primary');
  }
  if (
    !credentialSource.includes('pub(crate) async fn load_primary_session_v2') ||
    !credentialSource.includes('async fn persist_credential_v2') ||
    !authSource.includes('crate::qmapi::credential::load_primary_session_v2(') ||
    !authSource.includes('self.persist_credential_v2(&candidate).await')
  ) {
    throw new Error('credential-v2 production primary path is missing');
  }
  if (
    !accountSource.includes('async fn execute_playlist_write(') ||
    !/#\[cfg\(not\(test\)\)\][\s\S]{0,1600}crate::qmapi::account::execute_account_write\(/.test(
      accountSource,
    )
  ) {
    throw new Error('production account mutation hybrid is missing');
  }
  return blockers;
}

export function inspectP14cReadiness(root = repositoryRoot) {
  const record = JSON.parse(
    readFileSync(path.join(root, 'docs/migration/p14c-readiness.json'), 'utf8'),
  );
  const blockers = assertP14cPreparationGuards({
    record,
    providerManifest: readFileSync(
      path.join(root, 'crates/yaqmc-provider-qqmusic/Cargo.toml'),
      'utf8',
    ),
    coreManifest: readFileSync(path.join(root, 'crates/yaqmc-core/Cargo.toml'), 'utf8'),
    qmcSource: readFileSync(path.join(root, 'crates/yaqmc-provider-qqmusic/src/qmc.rs'), 'utf8'),
    authSource: readFileSync(
      path.join(root, 'crates/yaqmc-provider-qqmusic/src/qqmusic/auth.rs'),
      'utf8',
    ),
    credentialSource: readFileSync(
      path.join(root, 'crates/yaqmc-provider-qqmusic/src/qmapi/credential.rs'),
      'utf8',
    ),
    accountSource: readFileSync(
      path.join(root, 'crates/yaqmc-provider-qqmusic/src/qqmusic/account.rs'),
      'utf8',
    ),
  });
  return { record, blockers };
}

export function formatP14cStatus(record, blockers) {
  const status = blockers.length === 0 ? 'READY' : 'BLOCKED';
  const lines = [`P14-C STATUS: ${status}`];
  const blockerIds = new Set();
  for (const gate of blockers) {
    blockerIds.add(gate.id);
    const detail = gate.reason ? ` (${gate.reason})` : '';
    lines.push(`- ${gate.id}: ${gate.status}${detail}`);
  }
  for (const gate of record.gates) {
    if (gate.status === 'waived' && !blockerIds.has(gate.id)) {
      lines.push(`- ${gate.id}: waived`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  try {
    const { record, blockers } = inspectP14cReadiness();
    process.stdout.write(formatP14cStatus(record, blockers));
    if (argv.includes('--enforce') && blockers.length > 0) process.exitCode = 3;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write('P14-C STATUS: BLOCKED\n');
    process.stdout.write(`- record-invalid: ${message}\n`);
    process.exitCode = argv.includes('--enforce') ? 3 : 2;
  }
}

if (Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
