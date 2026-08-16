import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const expectedMembers = [
  ['yaqmc', 'src-tauri/Cargo.toml'],
  ['yaqmc-core', 'crates/yaqmc-core/Cargo.toml'],
  ['yaqmc-protocol', 'crates/yaqmc-protocol/Cargo.toml'],
  ['yaqmc-provider-api', 'crates/yaqmc-provider-api/Cargo.toml'],
  ['yaqmc-provider-qqmusic', 'crates/yaqmc-provider-qqmusic/Cargo.toml'],
];
const forbiddenCoreDependencyPatterns = [
  /^tauri(?:-.+)?$/,
  /^webkit2gtk(?:-.+)?$/,
  /^raw-window-handle$/,
  /^qqmusic-api$/,
  /^napi(?:-.+)?$/,
  /^(?:electron|node)(?:-.+)?$/,
  /^yaqmc$/,
  /^yaqmc-provider(?:-.+)?$/,
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
  if (existsSync(path.join(repositoryRoot, 'src-tauri', 'Cargo.lock'))) {
    throw new Error('member Cargo.lock must not exist');
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
  validateWorkspaceMetadata(cargoMetadata());
  validateDesktopCoreDependencyClosures(
    new Map(SUPPORTED_CORE_TARGETS.map((target) => [target, cargoMetadata(target)])),
  );
  process.stdout.write('Cargo workspace contract verified.\n');
}

if (Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
