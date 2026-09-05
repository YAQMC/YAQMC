import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QM_API_RS_GIT, QM_API_RS_REV, isPinnedQqmusicApiPackage } from './qm-api-rs-access.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const expectedMembers = [
  ['yaqmc-android', 'crates/yaqmc-android/Cargo.toml'],
  ['yaqmc-core', 'crates/yaqmc-core/Cargo.toml'],
  ['yaqmc-protocol', 'crates/yaqmc-protocol/Cargo.toml'],
  ['yaqmc-provider-api', 'crates/yaqmc-provider-api/Cargo.toml'],
  ['yaqmc-provider-qqmusic', 'crates/yaqmc-provider-qqmusic/Cargo.toml'],
];
const forbiddenCoreDependencyPatterns = [
  /^webkit2gtk(?:-.+)?$/,
  /^raw-window-handle$/,
  /^napi(?:-.+)?$/,
  /^(?:electron|node)(?:-.+)?$/,
  /^yaqmc$/,
];
export const SUPPORTED_CORE_TARGETS = Object.freeze([
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-pc-windows-msvc',
  'i686-pc-windows-msvc',
  'aarch64-pc-windows-msvc',
]);

export function validateWorkspaceMetadata(metadata) {
  const workspacePackages = metadata.packages
    .filter((pkg) => metadata.workspace_members.includes(pkg.id))
    .map((pkg) => [
      pkg.name,
      path.relative(repositoryRoot, pkg.manifest_path).replaceAll('\\', '/'),
    ])
    .sort(([left], [right]) => left.localeCompare(right));
  const expected = [...expectedMembers].sort(([left], [right]) => left.localeCompare(right));

  if (JSON.stringify(workspacePackages) !== JSON.stringify(expected)) {
    throw new Error(`unexpected Cargo workspace members: ${JSON.stringify(workspacePackages)}`);
  }
  if (path.resolve(metadata.target_directory) !== path.join(repositoryRoot, 'target')) {
    throw new Error(`unexpected Cargo target directory: ${metadata.target_directory}`);
  }
  if (!existsSync(path.join(repositoryRoot, 'Cargo.lock'))) {
    throw new Error('root Cargo.lock is missing');
  }
}

export function validateQqmusicApiLockPin(lockfileSource) {
  const source = `git+${QM_API_RS_GIT}?rev=${QM_API_RS_REV}`;
  if (
    !/^name = "qqmusic-api"$/m.test(lockfileSource) ||
    !lockfileSource.includes(`source = "${source}#${QM_API_RS_REV}"`)
  ) {
    throw new Error(`Cargo.lock must pin qqmusic-api at ${source}`);
  }
}

export function validateQqmusicApiMetadataIfPresent(metadata) {
  const linked = (metadata.packages ?? []).filter((pkg) => {
    const normalized = String(pkg.name ?? '')
      .toLowerCase()
      .replaceAll('_', '-');
    return normalized === 'qqmusic-api';
  });
  if (linked.length === 0) {
    return;
  }
  if (!linked.every((pkg) => isPinnedQqmusicApiPackage(pkg))) {
    throw new Error(
      `qqmusic-api in Cargo metadata must be git ${QM_API_RS_GIT} rev ${QM_API_RS_REV}`,
    );
  }
}

export function validateCoreDependencyClosure(metadata) {
  const core = metadata.packages.find((pkg) => pkg.name === 'yaqmc-core');
  if (!core) {
    throw new Error('yaqmc-core package is missing from Cargo metadata');
  }
  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodesById = new Map((metadata.resolve?.nodes ?? []).map((node) => [node.id, node]));
  if (!nodesById.has(core.id)) {
    throw new Error('yaqmc-core is missing from the Cargo resolve graph');
  }

  const pending = [core.id];
  const visited = new Set();
  const forbidden = new Set();
  while (pending.length > 0) {
    const packageId = pending.pop();
    if (visited.has(packageId)) continue;
    visited.add(packageId);

    const pkg = packagesById.get(packageId);
    if (!pkg) throw new Error(`Cargo resolve graph references an unknown package: ${packageId}`);
    const normalizedPackageName = pkg.name.toLowerCase().replaceAll('_', '-');
    if (
      packageId !== core.id &&
      forbiddenCoreDependencyPatterns.some((pattern) => pattern.test(normalizedPackageName))
    ) {
      forbidden.add(pkg.name);
    }
    for (const dependencyId of nodesById.get(packageId)?.dependencies ?? []) {
      pending.push(dependencyId);
    }
  }
  if (forbidden.size > 0) {
    throw new Error(`forbidden yaqmc-core dependency closure: ${[...forbidden].sort().join(', ')}`);
  }
}

export function validateDesktopCoreDependencyClosures(metadataByTarget) {
  for (const target of SUPPORTED_CORE_TARGETS) {
    const metadata = metadataByTarget.get(target);
    if (!metadata) throw new Error(`missing Cargo metadata for supported target: ${target}`);
    try {
      validateCoreDependencyClosure(metadata);
    } catch (error) {
      throw new Error(`${target}: ${error.message}`, { cause: error });
    }
  }
}

function cargoMetadata(target) {
  const args = ['metadata', '--format-version', '1', '--locked'];
  if (target) args.push('--filter-platform', target);
  return JSON.parse(
    execFileSync('cargo', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
}

function main() {
  const metadata = cargoMetadata();
  validateWorkspaceMetadata(metadata);
  validateQqmusicApiLockPin(readFileSync(path.join(repositoryRoot, 'Cargo.lock'), 'utf8'));
  validateQqmusicApiMetadataIfPresent(metadata);
  validateDesktopCoreDependencyClosures(
    new Map(SUPPORTED_CORE_TARGETS.map((target) => [target, cargoMetadata(target)])),
  );
  process.stdout.write('Cargo workspace contract verified.\n');
}

if (Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
