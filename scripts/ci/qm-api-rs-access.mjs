/**
 * Integrity helper for the public `qm-api-rs` production pin.
 *
 * The `qqmusic-api` dependency is unconditional since the production cutover; the
 * provider has no backend feature split and Core links it by default.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const QM_API_RS_GIT = 'https://github.com/YAQMC/qm-api-rs.git';
export const QM_API_RS_ORIGIN = 'https://github.com/YAQMC/qm-api-rs';
export const QM_API_RS_REV = '2ef9182732e02db23788175dbe5b7d9d937e328f';
export const QM_API_RS_CRATE = 'qqmusic-api';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function defaultSiblingCheckout(root = repositoryRoot) {
  return path.resolve(root, '..', 'qm-api-rs');
}

export function providerManifestPath(root = repositoryRoot) {
  return path.join(root, 'crates', 'yaqmc-provider-qqmusic', 'Cargo.toml');
}

export function assertProviderQmapiPin(manifestSource) {
  const defaultFeatures = manifestSource.match(/^default\s*=\s*\[([^\]]*)\]/m)?.[1] ?? '';
  if (defaultFeatures.trim() !== '') {
    throw new Error('provider default features must be empty after the production cutover');
  }
  if (/^qmapi\s*=\s*\[/m.test(manifestSource) || /^intree\s*=\s*\[/m.test(manifestSource)) {
    throw new Error('provider backend feature split must be removed after the production cutover');
  }
  const dependency = manifestSource.match(
    new RegExp(`${QM_API_RS_CRATE}\\s*=\\s*\\{([^}]+)\\}`, 'm'),
  );
  if (!dependency) {
    throw new Error(`${QM_API_RS_CRATE} git pin is missing from the provider manifest`);
  }
  const body = dependency[1];
  if (!body.includes(`git = "${QM_API_RS_GIT}"`)) {
    throw new Error(`${QM_API_RS_CRATE} must use git = "${QM_API_RS_GIT}"`);
  }
  if (!body.includes(`rev = "${QM_API_RS_REV}"`)) {
    throw new Error(`${QM_API_RS_CRATE} must pin rev = "${QM_API_RS_REV}"`);
  }
  if (/optional\s*=\s*true/.test(body)) {
    throw new Error(`${QM_API_RS_CRATE} must be unconditional after the production cutover`);
  }
}

export function isPinnedQqmusicApiPackage(pkg) {
  const name = String(pkg?.name ?? '')
    .toLowerCase()
    .replaceAll('_', '-');
  const id = String(pkg?.id ?? '');
  return (
    name === QM_API_RS_CRATE &&
    id.includes('github.com/YAQMC/qm-api-rs') &&
    id.includes(QM_API_RS_REV)
  );
}

export function readSiblingRevision(checkout, runGit = execFileSync) {
  if (!existsSync(path.join(checkout, '.git')) && !existsSync(path.join(checkout, 'Cargo.toml'))) {
    return null;
  }
  try {
    return runGit('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(`qm-api-rs checkout at ${checkout} is not a git repository`);
  }
}

export function assertSiblingMatchesPin(revision) {
  if (revision && revision !== QM_API_RS_REV) {
    throw new Error(
      `qm-api-rs checkout HEAD ${revision} does not match the production pin ${QM_API_RS_REV}`,
    );
  }
}

export function checkAccess(options = {}) {
  const root = options.root ?? repositoryRoot;
  const sibling = options.sibling ?? defaultSiblingCheckout(root);
  const manifest = readFileSync(providerManifestPath(root), 'utf8');
  assertProviderQmapiPin(manifest);
  const revision = options.siblingRevision ?? readSiblingRevision(sibling, options.runGit);
  assertSiblingMatchesPin(revision);
  return {
    git: QM_API_RS_GIT,
    rev: QM_API_RS_REV,
    crate: QM_API_RS_CRATE,
    sibling,
    siblingRevision: revision,
    linked: 'required',
  };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length > 0 && !argv.includes('--check')) {
    throw new Error(`unsupported qm-api-rs access option: ${argv.join(' ')}`);
  }
  const checked = checkAccess();
  const sibling =
    checked.siblingRevision == null
      ? 'no sibling checkout'
      : `sibling HEAD ${checked.siblingRevision}`;
  process.stdout.write(
    `qm-api-rs pin ${checked.rev} (${sibling}); ${checked.crate} is the unconditional production dependency\n`,
  );
}

if (Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
