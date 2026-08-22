import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const immutableRevision = /^[0-9a-f]{40}$/u;
const immutableSha256 = /^[0-9a-f]{64}$/u;
const githubCommentReference =
  /^github-comment:https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+#issuecomment-\d+$/u;

function usage() {
  return [
    'Usage: node scripts/validate-provenance-ledger.mjs [--ledger <path>] [--enforce]',
    '',
    'Report mode validates ledger structure and prints PASS or BLOCKED. It exits zero for a',
    'well-formed blocked ledger so release tooling can display all unresolved rights. --enforce',
    'exits non-zero unless the ledger is fully resolved and declares a pass decision.',
  ].join('\n');
}

function parseArgs(args) {
  const options = {
    enforce: false,
    ledger: path.join(repositoryRoot, 'docs', 'release', 'provenance-ledger.json'),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--enforce') {
      options.enforce = true;
    } else if (arg === '--ledger') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--ledger requires a path');
      options.ledger = path.resolve(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }

  return options;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(errors, value, label) {
  if (!isObject(value)) errors.push(`${label} must be an object`);
  return isObject(value);
}

function requireText(errors, value, label) {
  if (typeof value !== 'string' || value.trim() === '')
    errors.push(`${label} must be a non-empty string`);
}

function requireCoverage(errors, ledger, field) {
  if (!Array.isArray(ledger[field]) || ledger[field].length === 0) {
    errors.push(`${field} coverage must not be empty`);
    return false;
  }
  return true;
}

function isTypedImmutableEvidenceReference(reference) {
  if (typeof reference !== 'string') return false;
  if (reference.startsWith('git-object:') || reference.startsWith('signed-commit:')) {
    return immutableRevision.test(reference.slice(reference.indexOf(':') + 1));
  }
  if (reference.startsWith('sha256:'))
    return immutableSha256.test(reference.slice('sha256:'.length));
  return githubCommentReference.test(reference);
}

function normalizedRepositoryPath(url) {
  return url.pathname
    .replace(/\/+$/u, '')
    .replace(/\.git$/iu, '')
    .split('/')
    .filter(Boolean);
}

function isRevisionBoundSourceEvidence(reference, source) {
  const { revision } = source;
  if (reference === `git-object:${revision}` || reference === `signed-commit:${revision}`)
    return true;
  if (typeof reference !== 'string' || !reference.startsWith('git-revision-url:')) return false;

  try {
    const sourceUrl = new URL(source.origin);
    const evidenceUrl = new URL(reference.slice('git-revision-url:'.length));
    const sourceRepositoryPath = normalizedRepositoryPath(sourceUrl);
    const evidencePath = evidenceUrl.pathname.split('/').filter(Boolean);

    if (
      sourceUrl.protocol !== 'https:' ||
      evidenceUrl.protocol !== 'https:' ||
      sourceUrl.host.toLowerCase() !== evidenceUrl.host.toLowerCase() ||
      sourceRepositoryPath.length === 0 ||
      sourceRepositoryPath.some((segment, index) => evidencePath[index] !== segment)
    ) {
      return false;
    }

    return evidencePath.slice(sourceRepositoryPath.length).includes(revision);
  } catch {
    return false;
  }
}

function collectBlockers(ledger) {
  const blockers = [];
  const sourceIds = new Set();

  for (const source of ledger.sources) {
    sourceIds.add(source.id);
    if (!immutableRevision.test(source.revision ?? '')) {
      blockers.push(`source:${source.id} immutable revision is missing or invalid`);
    }
    if (
      typeof source.license !== 'string' ||
      source.license.trim() === '' ||
      /^(NOASSERTION|UNKNOWN)$/iu.test(source.license.trim())
    ) {
      blockers.push(`source:${source.id} license=${source.license ?? 'unknown'}`);
    }
    if (!Array.isArray(source.mappings) || source.mappings.length === 0) {
      blockers.push(`source:${source.id} has no target mapping`);
    }
    if (source.status !== 'verified') {
      blockers.push(`source:${source.id} status=${source.status ?? 'unknown'}`);
    } else if (
      !Array.isArray(source.evidence) ||
      !source.evidence.some((evidence) => isRevisionBoundSourceEvidence(evidence, source))
    ) {
      blockers.push(`source:${source.id} verified status lacks revision-bound immutable evidence`);
    }
    if (source.noticeStatus === 'incomplete' || source.noticeStatus === 'missing') {
      blockers.push(`source:${source.id} noticeStatus=${source.noticeStatus}`);
    }
    if (source.kind === 'proprietary-client-extraction') {
      const authorization = source.authorization;
      if (
        !isObject(authorization) ||
        authorization.status !== 'verified' ||
        !isTypedImmutableEvidenceReference(authorization.evidence)
      ) {
        blockers.push(
          `source:${source.id} proprietary-client-extraction lacks typed immutable authorization evidence`,
        );
      }
    }
  }

  for (const contributor of ledger.contributors) {
    if (contributor.consentStatus !== 'verified') {
      blockers.push(
        `contributor:${contributor.id} consentStatus=${contributor.consentStatus ?? 'unknown'}`,
      );
    } else if (!isTypedImmutableEvidenceReference(contributor.evidence)) {
      blockers.push(
        `contributor:${contributor.id} verified consent lacks typed immutable evidence`,
      );
    }
  }

  for (const asset of ledger.assets) {
    if (!sourceIds.has(asset.sourceId)) {
      blockers.push(
        `asset:${asset.id} references an unknown sourceId=${asset.sourceId ?? 'unknown'}`,
      );
    }
    if (asset.status !== 'verified') {
      blockers.push(`asset:${asset.id} status=${asset.status ?? 'unknown'}`);
    } else if (!isTypedImmutableEvidenceReference(asset.evidence)) {
      blockers.push(`asset:${asset.id} verified status lacks typed immutable evidence`);
    }
  }

  if (ledger.release.decision === 'pass' && blockers.length > 0) {
    blockers.push('release declares pass despite unresolved provenance');
  }

  return [...new Set(blockers)];
}

function validateStructure(ledger) {
  const errors = [];
  if (!requireObject(errors, ledger, 'ledger')) return errors;
  if (ledger.schemaVersion !== 1) errors.push('schemaVersion must equal 1');

  if (requireObject(errors, ledger.audit, 'audit')) {
    if (requireObject(errors, ledger.audit.repository, 'audit.repository')) {
      requireText(errors, ledger.audit.repository.auditHead, 'audit.repository.auditHead');
      if (!immutableRevision.test(ledger.audit.repository.auditHead ?? '')) {
        errors.push('audit.repository.auditHead must be an immutable 40-character SHA');
      }
      if (
        requireObject(
          errors,
          ledger.audit.repository.historicalBase,
          'audit.repository.historicalBase',
        )
      ) {
        requireText(
          errors,
          ledger.audit.repository.historicalBase.commit,
          'audit.repository.historicalBase.commit',
        );
        if (!immutableRevision.test(ledger.audit.repository.historicalBase.commit ?? '')) {
          errors.push(
            'audit.repository.historicalBase.commit must be an immutable 40-character SHA',
          );
        }
      }
    }
    if (requireObject(errors, ledger.audit.qmApiRs, 'audit.qmApiRs')) {
      requireText(errors, ledger.audit.qmApiRs.revision, 'audit.qmApiRs.revision');
      if (!immutableRevision.test(ledger.audit.qmApiRs.revision ?? '')) {
        errors.push('audit.qmApiRs.revision must be an immutable 40-character SHA');
      }
    }
  }

  const sourcesPresent = requireCoverage(errors, ledger, 'sources');
  const contributorsPresent = requireCoverage(errors, ledger, 'contributors');
  const assetsPresent = requireCoverage(errors, ledger, 'assets');

  if (sourcesPresent) {
    const ids = new Set();
    for (const source of ledger.sources) {
      if (!requireObject(errors, source, 'source')) continue;
      requireText(errors, source.id, 'source.id');
      requireText(errors, source.origin, `source:${source.id ?? 'unknown'}.origin`);
      requireText(errors, source.license, `source:${source.id ?? 'unknown'}.license`);
      if (typeof source.id === 'string') {
        if (ids.has(source.id)) errors.push(`duplicate source id ${source.id}`);
        ids.add(source.id);
      }
      if (!Array.isArray(source.mappings)) {
        errors.push(`source:${source.id ?? 'unknown'}.mappings must be an array`);
      } else {
        for (const mapping of source.mappings) {
          if (!requireObject(errors, mapping, `source:${source.id ?? 'unknown'}.mapping`)) continue;
          requireText(errors, mapping.target, `source:${source.id ?? 'unknown'}.mapping.target`);
          requireText(
            errors,
            mapping.relation,
            `source:${source.id ?? 'unknown'}.mapping.relation`,
          );
        }
      }
    }
  }

  if (contributorsPresent) {
    for (const contributor of ledger.contributors) {
      if (!requireObject(errors, contributor, 'contributor')) continue;
      requireText(errors, contributor.id, 'contributor.id');
      requireText(errors, contributor.name, `contributor:${contributor.id ?? 'unknown'}.name`);
      requireText(
        errors,
        contributor.consentStatus,
        `contributor:${contributor.id ?? 'unknown'}.consentStatus`,
      );
      requireText(
        errors,
        contributor.rightsScope,
        `contributor:${contributor.id ?? 'unknown'}.rightsScope`,
      );
    }
  }

  if (assetsPresent) {
    for (const asset of ledger.assets) {
      if (!requireObject(errors, asset, 'asset')) continue;
      requireText(errors, asset.id, 'asset.id');
      requireText(errors, asset.path, `asset:${asset.id ?? 'unknown'}.path`);
      requireText(errors, asset.sourceId, `asset:${asset.id ?? 'unknown'}.sourceId`);
      requireText(errors, asset.status, `asset:${asset.id ?? 'unknown'}.status`);
    }
  }

  if (requireObject(errors, ledger.release, 'release')) {
    if (!['pass', 'block'].includes(ledger.release.decision)) {
      errors.push('release.decision must equal pass or block');
    }
    if (!Array.isArray(ledger.release.blockers)) errors.push('release.blockers must be an array');
  }

  return errors;
}

async function readLedger(ledgerPath) {
  let text;
  try {
    text = await readFile(ledgerPath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ledger ${ledgerPath}: ${error.message}`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`ledger is not valid JSON: ${error.message}`, { cause: error });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const ledger = await readLedger(options.ledger);
  const structuralErrors = validateStructure(ledger);
  if (structuralErrors.length > 0) {
    process.stderr.write(`Ledger schema invalid (${structuralErrors.length}):\n`);
    for (const error of structuralErrors) process.stderr.write(`- ${error}\n`);
    process.exitCode = 2;
    return;
  }

  const blockers = [...new Set([...collectBlockers(ledger), ...ledger.release.blockers])];
  const blocked = blockers.length > 0 || ledger.release.decision !== 'pass';
  process.stdout.write(`PROVENANCE STATUS: ${blocked ? 'BLOCKED' : 'PASS'}\n`);
  process.stdout.write(`release decision: ${ledger.release.decision}\n`);
  process.stdout.write(`ledger: ${options.ledger}\n`);
  if (blockers.length > 0) {
    process.stdout.write(`blockers (${blockers.length}):\n`);
    for (const blocker of blockers) process.stdout.write(`- ${blocker}\n`);
  }

  if (options.enforce && blocked) {
    process.stderr.write(
      'Provenance enforcement failed: unresolved copyright, source, or release evidence remains.\n',
    );
    process.exitCode = 3;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
