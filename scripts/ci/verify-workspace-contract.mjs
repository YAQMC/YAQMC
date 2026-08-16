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

function main() {
  const metadata = JSON.parse(
    execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--locked'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }),
  );
  validateWorkspaceMetadata(metadata);
  process.stdout.write('Cargo workspace contract verified.\n');
}

if (Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
