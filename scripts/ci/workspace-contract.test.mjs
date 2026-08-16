import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateWorkspaceMetadata } from './verify-workspace-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function metadataWithTargetDirectory(targetDirectory) {
  const members = [
    ['yaqmc', 'src-tauri/Cargo.toml'],
    ['yaqmc-core', 'crates/yaqmc-core/Cargo.toml'],
    ['yaqmc-protocol', 'crates/yaqmc-protocol/Cargo.toml'],
    ['yaqmc-provider-api', 'crates/yaqmc-provider-api/Cargo.toml'],
    ['yaqmc-provider-qqmusic', 'crates/yaqmc-provider-qqmusic/Cargo.toml'],
  ];
  return {
    target_directory: targetDirectory,
    workspace_members: members.map(([name]) => `path+file:///workspace#${name}`),
    packages: members.map(([name, manifest]) => ({
      id: `path+file:///workspace#${name}`,
      name,
      manifest_path: path.join(repositoryRoot, manifest),
    })),
  };
}

test('accepts exactly the root workspace metadata contract', () => {
  assert.doesNotThrow(() =>
    validateWorkspaceMetadata(metadataWithTargetDirectory(path.join(repositoryRoot, 'target'))),
  );
});

test('rejects metadata that points Cargo output back under the Tauri member', () => {
  assert.throws(
    () =>
      validateWorkspaceMetadata(
        metadataWithTargetDirectory(path.join(repositoryRoot, 'src-tauri', 'target')),
      ),
    /Cargo target directory/,
  );
});
