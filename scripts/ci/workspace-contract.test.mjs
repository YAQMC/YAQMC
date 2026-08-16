import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  validateCoreDependencyClosure,
  validateWorkspaceMetadata,
} from './verify-workspace-contract.mjs';

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

function metadataWithCoreClosure(packages) {
  const metadata = metadataWithTargetDirectory(path.join(repositoryRoot, 'target'));
  const core = metadata.packages.find((pkg) => pkg.name === 'yaqmc-core');
  const resolvedPackages = packages.map(([name]) => ({
    id: `registry+https://example.invalid/index#${name}`,
    name,
  }));
  const packageByName = new Map(resolvedPackages.map((pkg) => [pkg.name, pkg]));
  const dependencyIdsFor = (name) =>
    (packages.find(([candidate]) => candidate === name)?.[1] ?? []).map(
      (dependencyName) => packageByName.get(dependencyName).id,
    );
  metadata.packages.push(...resolvedPackages);
  metadata.resolve = {
    nodes: [
      {
        id: core.id,
        dependencies: dependencyIdsFor('yaqmc-core'),
      },
      ...resolvedPackages.map((pkg) => ({
        id: pkg.id,
        dependencies: dependencyIdsFor(pkg.name),
      })),
    ],
  };
  return metadata;
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

test('accepts a host-neutral Core dependency closure', () => {
  assert.doesNotThrow(() =>
    validateCoreDependencyClosure(
      metadataWithCoreClosure([
        ['yaqmc-core', ['tokio']],
        ['tokio', []],
      ]),
    ),
  );
});

test('accepts portable reqwest in the Core dependency closure', () => {
  assert.doesNotThrow(() =>
    validateCoreDependencyClosure(
      metadataWithCoreClosure([
        ['yaqmc-core', ['reqwest']],
        ['reqwest', ['hyper']],
        ['hyper', []],
      ]),
    ),
  );
});

test('rejects a forbidden host dependency reached transitively from Core', () => {
  assert.throws(
    () =>
      validateCoreDependencyClosure(
        metadataWithCoreClosure([
          ['yaqmc-core', ['portable-layer']],
          ['portable-layer', ['tauri']],
          ['tauri', []],
        ]),
      ),
    /forbidden yaqmc-core dependency closure: tauri/,
  );
});

test('rejects a transitive provider dependency reached from Core', () => {
  assert.throws(
    () =>
      validateCoreDependencyClosure(
        metadataWithCoreClosure([
          ['yaqmc-core', ['portable-layer']],
          ['portable-layer', ['yaqmc-provider-qqmusic']],
          ['yaqmc-provider-qqmusic', []],
        ]),
      ),
    /forbidden yaqmc-core dependency closure: yaqmc-provider-qqmusic/,
  );
});

test('rejects underscore-form forbidden dependencies reached transitively from Core', () => {
  for (const forbidden of [
    'tauri_plugin_dialog',
    'raw_window_handle',
    'qqmusic_api',
    'napi_build',
    'yaqmc_provider_qqmusic',
  ]) {
    assert.throws(
      () =>
        validateCoreDependencyClosure(
          metadataWithCoreClosure([
            ['yaqmc-core', ['portable-layer']],
            ['portable-layer', [forbidden]],
            [forbidden, []],
          ]),
        ),
      new RegExp(`forbidden yaqmc-core dependency closure: ${forbidden}`),
    );
  }
});
