import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectP14cReadiness } from './p14c-readiness.mjs';
import { QM_API_RS_ORIGIN, QM_API_RS_REV } from './qm-api-rs-access.mjs';
import { sha256File } from './write-build-info.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const immutableRevision = /^[0-9a-f]{40}$/u;

export const CORRESPONDING_SOURCE_MANIFEST = 'CORRESPONDING-SOURCE-MANIFEST.json';
export const YAQMC_ORIGIN = 'https://github.com/YAQMC/YAQMC';

export function parseCorrespondingSourceArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`);
    }
    options[arg.slice(2)] = value;
    index += 1;
  }
  return options;
}

function defaultRunGit(repository, args) {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function defaultRunProvenanceGate(root) {
  execFileSync(
    process.execPath,
    [path.join(root, 'scripts', 'validate-provenance-ledger.mjs'), '--enforce'],
    { cwd: root, stdio: 'inherit' },
  );
}

function repositoryRevision(repository, runGit) {
  const revision = runGit(repository, ['rev-parse', 'HEAD']).trim();
  if (!immutableRevision.test(revision)) {
    throw new Error(`repository at ${repository} did not resolve to an immutable commit`);
  }
  return revision;
}

function assertCleanCheckout(repository, runGit) {
  const status = runGit(repository, ['status', '--porcelain=v1', '--untracked-files=all']).trim();
  if (status.length > 0) {
    throw new Error(`corresponding source requires a clean checkout: ${repository}`);
  }
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function trackedTextAt(repository, revision, file, runGit) {
  return runGit(repository, ['show', `${revision}:${file}`]);
}

function trackedFilesAt(repository, revision, runGit) {
  return runGit(repository, ['ls-tree', '-r', '--name-only', revision])
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((entry) => entry.replaceAll('\\', '/'));
}

function assertSourceShape(component, files, requiredFiles) {
  const tracked = new Set(files);
  for (const required of requiredFiles) {
    if (!tracked.has(required)) {
      throw new Error(`${component} source is missing tracked build input ${required}`);
    }
  }
  const licenseFiles = files.filter((entry) =>
    /(^|\/)(?:LICENSE|COPYING)(?:[.-].*)?$/iu.test(entry),
  );
  if (licenseFiles.length === 0) {
    throw new Error(`${component} source has no tracked license file`);
  }
  return licenseFiles.sort();
}

function archiveRepository({ repository, revision, prefix, output, runGit }) {
  if (existsSync(output)) {
    throw new Error(`refusing to overwrite corresponding-source archive ${output}`);
  }
  runGit(repository, [
    'archive',
    '--format=zip',
    `--prefix=${prefix}/`,
    `--output=${output}`,
    revision,
  ]);
  if (!existsSync(output) || statSync(output).size === 0) {
    throw new Error(`git archive did not create ${output}`);
  }
}

export function createCorrespondingSourceBundle(options = {}) {
  const yaqmcRoot = path.resolve(options.yaqmcRoot ?? repositoryRoot);
  const qmApiRsRoot = path.resolve(options.qmApiRsRoot ?? path.join(yaqmcRoot, '..', 'qm-api-rs'));
  const outputDir = path.resolve(options.outputDir ?? path.join(yaqmcRoot, 'corresponding-source'));
  const runGit = options.runGit ?? defaultRunGit;
  const runProvenanceGate = options.runProvenanceGate ?? defaultRunProvenanceGate;

  assertCleanCheckout(yaqmcRoot, runGit);
  assertCleanCheckout(qmApiRsRoot, runGit);
  runProvenanceGate(yaqmcRoot);
  const { record, blockers } = inspectP14cReadiness(yaqmcRoot);
  if (blockers.length > 0) {
    throw new Error(
      `Provider readiness corresponding-source gate is blocked: ${blockers.map((gate) => gate.id).join(', ')}`,
    );
  }

  const yaqmcRevision = repositoryRevision(yaqmcRoot, runGit);
  const qmApiRsRevision = repositoryRevision(qmApiRsRoot, runGit);
  if (qmApiRsRevision !== QM_API_RS_REV || record.targetPin !== qmApiRsRevision) {
    throw new Error(
      `qm-api-rs source revision ${qmApiRsRevision} does not match the production pin ${QM_API_RS_REV}`,
    );
  }

  const yaqmcFiles = trackedFilesAt(yaqmcRoot, yaqmcRevision, runGit);
  const qmApiRsFiles = trackedFilesAt(qmApiRsRoot, qmApiRsRevision, runGit);
  const yaqmcLicenses = assertSourceShape('YAQMC', yaqmcFiles, [
    'Cargo.toml',
    'Cargo.lock',
    'package.json',
    'package-lock.json',
    '.github/workflows/electron-release.yml',
  ]);
  const qmApiRsLicenses = assertSourceShape('qm-api-rs', qmApiRsFiles, ['Cargo.toml']);

  mkdirSync(outputDir, { recursive: true });
  const yaqmcArchiveName = `YAQMC-source-${yaqmcRevision}.zip`;
  const qmApiRsArchiveName = `qm-api-rs-source-${qmApiRsRevision}.zip`;
  const yaqmcArchive = path.join(outputDir, yaqmcArchiveName);
  const qmApiRsArchive = path.join(outputDir, qmApiRsArchiveName);
  archiveRepository({
    repository: yaqmcRoot,
    revision: yaqmcRevision,
    prefix: `YAQMC-${yaqmcRevision}`,
    output: yaqmcArchive,
    runGit,
  });
  archiveRepository({
    repository: qmApiRsRoot,
    revision: qmApiRsRevision,
    prefix: `qm-api-rs-${qmApiRsRevision}`,
    output: qmApiRsArchive,
    runGit,
  });

  const readinessRecord = 'docs/release/provider-readiness.json';
  const provenanceLedger = 'docs/release/provenance-ledger.json';
  const provenanceEvidence = ['docs/release/provenance.md', 'docs/release/qm-api-rs-provenance.md'];
  const manifest = {
    schemaVersion: 1,
    license: 'GPL-3.0-or-later',
    releaseCommit: yaqmcRevision,
    qmApiRsRevision,
    p14c: {
      status: 'READY',
      targetPin: record.targetPin,
      readinessRecord,
      readinessSha256: sha256Text(trackedTextAt(yaqmcRoot, yaqmcRevision, readinessRecord, runGit)),
    },
    provenance: {
      status: 'PASS',
      ledger: provenanceLedger,
      ledgerSha256: sha256Text(trackedTextAt(yaqmcRoot, yaqmcRevision, provenanceLedger, runGit)),
      evidence: provenanceEvidence,
      evidenceSha256: Object.fromEntries(
        provenanceEvidence.map((file) => [
          file,
          sha256Text(trackedTextAt(yaqmcRoot, yaqmcRevision, file, runGit)),
        ]),
      ),
    },
    components: [
      {
        name: 'YAQMC',
        origin: YAQMC_ORIGIN,
        revision: yaqmcRevision,
        archive: yaqmcArchiveName,
        sha256: sha256File(yaqmcArchive),
        licenseFiles: yaqmcLicenses,
      },
      {
        name: 'qm-api-rs',
        origin: QM_API_RS_ORIGIN,
        revision: qmApiRsRevision,
        archive: qmApiRsArchiveName,
        sha256: sha256File(qmApiRsArchive),
        licenseFiles: qmApiRsLicenses,
      },
    ],
  };
  const manifestPath = path.join(outputDir, CORRESPONDING_SOURCE_MANIFEST);
  if (existsSync(manifestPath)) {
    throw new Error(`refusing to overwrite corresponding-source manifest ${manifestPath}`);
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestPath, outputDir };
}

function main() {
  const args = parseCorrespondingSourceArgs(process.argv.slice(2));
  if (!args['qm-api-rs-root'] || !args.to) {
    throw new Error(
      'Usage: corresponding-source.mjs --qm-api-rs-root <checkout> --to <directory> [--yaqmc-root <checkout>]',
    );
  }
  const result = createCorrespondingSourceBundle({
    yaqmcRoot: args['yaqmc-root'],
    qmApiRsRoot: args['qm-api-rs-root'],
    outputDir: args.to,
  });
  process.stdout.write(`corresponding source: ${result.manifestPath}\n`);
}

if (Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
