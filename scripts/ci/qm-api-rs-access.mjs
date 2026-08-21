/**
 * Access helper for the private `qm-api-rs` pin.
 *
 * The `qqmusic-api` dependency is unconditional since the P14-C cutover; the
 * provider has no backend feature split and Core links it by default.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const QM_API_RS_GIT = 'https://github.com/YAQMC/qm-api-rs.git';
export const QM_API_RS_ORIGIN = 'https://github.com/YAQMC/qm-api-rs';
export const QM_API_RS_REV = 'ffcc86cec2993b79ccf34faf25c1eba6c0d995ca';
export const QM_API_RS_CRATE = 'qqmusic-api';
export const QM_API_RS_TOKEN_ENV = 'QM_API_RS_TOKEN';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function defaultSiblingCheckout(root = repositoryRoot) {
  return path.resolve(root, '..', 'qm-api-rs');
}

export function providerManifestPath(root = repositoryRoot) {
  return path.join(root, 'crates', 'yaqmc-provider-qqmusic', 'Cargo.toml');
}

export function sanitizeAccessToken(token) {
  const value = String(token ?? '').trim();
  if (!value) {
    return '';
  }
  if (/[\s@"'\\]/.test(value)) {
    throw new Error(
      `${QM_API_RS_TOKEN_ENV} contains characters that cannot be used in a git insteadOf URL`,
    );
  }
  return value;
}

export function insteadOfRewriteUrl(token) {
  const safe = sanitizeAccessToken(token);
  if (!safe) {
    throw new Error(`${QM_API_RS_TOKEN_ENV} is required to configure git insteadOf`);
  }
  return `https://x-access-token:${safe}@github.com/YAQMC/qm-api-rs`;
}

export function gitInsteadOfArgs(token, scope = 'global') {
  if (scope !== 'global' && scope !== 'local') {
    throw new Error(`unsupported git config scope: ${scope}`);
  }
  return ['config', `--${scope}`, `url.${insteadOfRewriteUrl(token)}.insteadOf`, QM_API_RS_GIT];
}

export function assertProviderQmapiPin(manifestSource) {
  const defaultFeatures = manifestSource.match(/^default\s*=\s*\[([^\]]*)\]/m)?.[1] ?? '';
  if (defaultFeatures.trim() !== '') {
    throw new Error('provider default features must be empty after the P14-C cutover');
  }
  if (/^qmapi\s*=\s*\[/m.test(manifestSource) || /^intree\s*=\s*\[/m.test(manifestSource)) {
    throw new Error('provider backend feature split must be removed after the P14-C cutover');
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
    throw new Error(`${QM_API_RS_CRATE} must be unconditional after the P14-C cutover`);
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
      `qm-api-rs checkout HEAD ${revision} does not match the P14 pin ${QM_API_RS_REV}`,
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

export function configureGitInsteadOf(options = {}) {
  const env = options.env ?? process.env;
  const ci = env.CI === 'true' || env.YAQMC_QM_API_RS_CONFIGURE_GIT === '1';
  if (!ci) {
    throw new Error(
      'refusing to write git config outside CI; set CI=true or YAQMC_QM_API_RS_CONFIGURE_GIT=1',
    );
  }
  const token = sanitizeAccessToken(env[QM_API_RS_TOKEN_ENV]);
  if (!token) {
    return {
      configured: false,
      reason: `${QM_API_RS_TOKEN_ENV} unset; the unconditional qmapi pin cannot be fetched`,
    };
  }
  const runGit = options.runGit ?? execFileSync;
  runGit('git', gitInsteadOfArgs(token, options.scope ?? 'global'), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { configured: true, insteadOf: QM_API_RS_GIT };
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--configure-git')) {
    const result = configureGitInsteadOf();
    process.stdout.write(
      `${result.configured ? 'configured' : 'skipped'}: ${result.reason ?? QM_API_RS_GIT}\n`,
    );
    return;
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
