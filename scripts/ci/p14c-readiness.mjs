import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QM_API_RS_REV } from './qm-api-rs-access.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exactPinSoakGateId = 'exact-pin-three-day-soak';
const immutableRevision = /^[0-9a-f]{40}$/u;
const isoDate = /^\d{4}-\d{2}-\d{2}$/u;
const allowedGateStatuses = new Set(['pass', 'waived', 'blocked', 'not-started']);
const allowedWaiverKinds = new Set(['maintainer-authorized-skip']);
const requiredGateIds = new Set([
  'p14b-live-hybrid',
  'retirement-scope',
  'crate-provenance',
  'production-qmc-library',
  exactPinSoakGateId,
  'production-credential-primary',
  'production-account-mutation-hybrid',
]);
const retainedLegacyCredentialResponsibility = 'legacy-session-migration-rollback-slot';

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function requireIsoDate(value, label) {
  requireString(value, label);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !isoDate.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${label} must be an ISO calendar date`);
  }
}

function requireEvidenceFile(value, label, root) {
  requireString(value, label);
  const normalized = value.replaceAll('\\', '/');
  if (
    path.posix.isAbsolute(normalized) ||
    path.posix.normalize(normalized) !== normalized ||
    !normalized.startsWith('docs/release/')
  ) {
    throw new Error(`${label} must be a repository-relative docs/release path`);
  }
  const resolved = path.resolve(root, ...normalized.split('/'));
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the repository`);
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`${label} does not exist: ${normalized}`);
  }
}

function requireUniqueStrings(entries, label) {
  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(`${label} contains an invalid entry`);
    }
    if (seen.has(entry)) {
      throw new Error(`${label} contains duplicate entry ${entry}`);
    }
    seen.add(entry);
  }
  return seen;
}

export function validateP14cRecord(record, options = {}) {
  const root = path.resolve(options.root ?? repositoryRoot);
  if (record?.schemaVersion !== 1 || record?.phase !== 'P14-C') {
    throw new Error('Provider readiness record has an unsupported schema or phase');
  }
  if (record.targetPin !== QM_API_RS_REV) {
    throw new Error(`Provider readiness target pin must match ${QM_API_RS_REV}`);
  }
  requireString(record.cutoverBaselinePin, 'Provider cutover baseline pin');
  if (!immutableRevision.test(record.cutoverBaselinePin)) {
    throw new Error('Provider cutover baseline pin must be an immutable 40-character SHA');
  }
  if (typeof record.cutoverAuthorized !== 'boolean') {
    throw new Error('Provider readiness cutoverAuthorized must be a boolean');
  }
  if (!['intree', 'qmapi'].includes(record.defaultBackend)) {
    throw new Error('Provider readiness defaultBackend must be intree or qmapi');
  }
  if (record.cutoverAuthorized && record.defaultBackend !== 'qmapi') {
    throw new Error('An authorized provider cutover must use the qmapi backend');
  }
  if (!record.cutoverAuthorized && record.defaultBackend !== 'intree') {
    throw new Error('An unauthorized provider cutover must keep the intree backend');
  }
  if (!Array.isArray(record.gates) || record.gates.length === 0) {
    throw new Error('Provider readiness record must contain gates');
  }

  const ids = new Set();
  for (const gate of record.gates) {
    requireString(gate?.id, 'gate id');
    if (!requiredGateIds.has(gate.id)) {
      throw new Error(`unsupported provider readiness gate ${gate.id}`);
    }
    requireString(gate?.status, `gate ${gate.id} status`);
    if (!allowedGateStatuses.has(gate.status)) {
      throw new Error(`gate ${gate.id} has unsupported status ${gate.status}`);
    }
    requireEvidenceFile(gate.evidence, `evidence for gate ${gate.id}`, root);
    if (ids.has(gate.id)) throw new Error(`duplicate provider readiness gate: ${gate.id}`);
    ids.add(gate.id);
    if (gate.status === 'waived') {
      requireString(gate.waivedBy, `waivedBy for gate ${gate.id}`);
      requireIsoDate(gate.waivedOn, `waivedOn for gate ${gate.id}`);
      requireString(gate.waiverKind, `waiverKind for gate ${gate.id}`);
      if (!allowedWaiverKinds.has(gate.waiverKind)) {
        throw new Error(`gate ${gate.id} has unsupported waiverKind ${gate.waiverKind}`);
      }
    }
  }
  for (const id of requiredGateIds) {
    if (!ids.has(id)) {
      throw new Error(`Provider readiness record is missing required gate ${id}`);
    }
  }

  const exactPinSoakGates = record.gates.filter((gate) => gate.id === exactPinSoakGateId);
  if (exactPinSoakGates.length !== 1) {
    throw new Error(
      `Provider readiness record must contain exactly one ${exactPinSoakGateId} gate`,
    );
  }
  const [exactPinSoakGate] = exactPinSoakGates;
  requireString(exactPinSoakGate.appliesToPin, `target pin for gate ${exactPinSoakGateId}`);
  if (!immutableRevision.test(exactPinSoakGate.appliesToPin)) {
    throw new Error(`target pin for gate ${exactPinSoakGateId} must be immutable`);
  }

  const responsibilitySets = {};
  for (const name of ['retireAfterGates', 'keep']) {
    const entries = record.responsibilities?.[name];
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`Provider responsibilities.${name} must be a non-empty array`);
    }
    responsibilitySets[name] = requireUniqueStrings(entries, `Provider responsibilities.${name}`);
  }
  const pending = record.responsibilities?.pendingProductionReplacement;
  if (!Array.isArray(pending)) {
    throw new Error('Provider responsibilities.pendingProductionReplacement must be an array');
  }
  const pendingSet = requireUniqueStrings(
    pending,
    'Provider responsibilities.pendingProductionReplacement',
  );
  for (const entry of responsibilitySets.retireAfterGates) {
    if (responsibilitySets.keep.has(entry) || pendingSet.has(entry)) {
      throw new Error(`Provider responsibility ${entry} appears in incompatible lists`);
    }
  }
  for (const entry of responsibilitySets.keep) {
    if (pendingSet.has(entry)) {
      throw new Error(`Provider responsibility ${entry} appears in incompatible lists`);
    }
  }
  if (!responsibilitySets.keep.has(retainedLegacyCredentialResponsibility)) {
    throw new Error(
      `Provider responsibilities.keep must retain ${retainedLegacyCredentialResponsibility}`,
    );
  }
  if (record.cutoverAuthorized && pending.length > 0) {
    throw new Error('Provider cutover cannot be authorized with pending production replacements');
  }

  const blockers = record.gates.filter(
    (gate) => gate.status !== 'pass' && gate.status !== 'waived',
  );
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
    throw new Error('Provider cutover cannot be authorized while gates are open');
  }
  if (!record.cutoverAuthorized) {
    blockers.push({
      id: 'cutover-authorization',
      status: 'blocked',
      reason: 'maintainer authorization has not been recorded',
    });
  }
  return blockers;
}

export function assertP14cPreparationGuards({
  root = repositoryRoot,
  record,
  providerManifest,
  coreManifest,
  qmcSource,
  authSource,
  credentialSource,
  accountSource,
}) {
  const blockers = validateP14cRecord(record, { root });
  const reviewingAPostCutoverPin =
    record.cutoverAuthorized && record.targetPin !== record.cutoverBaselinePin;
  const preparationBlockers = reviewingAPostCutoverPin
    ? blockers.filter((gate) => gate.id !== exactPinSoakGateId)
    : blockers;
  if (preparationBlockers.length > 0 && record.defaultBackend !== 'intree') {
    throw new Error('Provider default backend must remain intree while gates are open');
  }
  if (!/^default\s*=\s*\[\]$/m.test(providerManifest)) {
    throw new Error('provider must have empty default features after the production cutover');
  }
  if (
    !/^qqmusic-api\s*=\s*\{[^\n]*git\s*=\s*"[^"]+"[^\n]*rev\s*=\s*"[^"]+"[^\n]*\}$/m.test(
      providerManifest,
    ) ||
    /^qqmusic-api\s*=\s*\{[^\n]*optional\s*=\s*true[^\n]*\}$/m.test(providerManifest)
  ) {
    throw new Error('qqmusic-api must be an unconditional git pin after the production cutover');
  }
  if (/^qqmusic-qmapi\s*=\s*\[/m.test(coreManifest)) {
    throw new Error('Core must drop the qqmusic-qmapi opt-in after the production cutover');
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
    readFileSync(path.join(root, 'docs/release/provider-readiness.json'), 'utf8'),
  );
  const blockers = assertP14cPreparationGuards({
    root,
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
  const lines = [`PROVIDER READINESS STATUS: ${status}`];
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
    process.stdout.write('PROVIDER READINESS STATUS: BLOCKED\n');
    process.stdout.write(`- record-invalid: ${message}\n`);
    process.exitCode = argv.includes('--enforce') ? 3 : 2;
  }
}

if (Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
