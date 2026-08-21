import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SUPPORTED_CORE_TARGETS,
  validateCoreDependencyClosure,
  validateDesktopCoreDependencyClosures,
  validateQqmusicApiLockPin,
  validateQqmusicApiMetadataIfPresent,
  validateWorkspaceMetadata,
} from './verify-workspace-contract.mjs';
import { QM_API_RS_GIT, QM_API_RS_REV } from './qm-api-rs-access.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function metadataWithTargetDirectory(targetDirectory) {
  const members = [
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

test('rejects metadata that points Cargo output under a workspace member', () => {
  assert.throws(
    () =>
      validateWorkspaceMetadata(
        metadataWithTargetDirectory(path.join(repositoryRoot, 'crates', 'yaqmc-core', 'target')),
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

test('checks the Core closure on exactly the five supported desktop targets', () => {
  assert.deepEqual(SUPPORTED_CORE_TARGETS, [
    'x86_64-unknown-linux-gnu',
    'aarch64-unknown-linux-gnu',
    'x86_64-pc-windows-msvc',
    'i686-pc-windows-msvc',
    'aarch64-pc-windows-msvc',
  ]);

  const portable = metadataWithCoreClosure([
    ['yaqmc-core', ['rodio']],
    ['rodio', ['cpal']],
    ['cpal', []],
    ['raw-window-handle', []],
  ]);
  const metadataByTarget = new Map(SUPPORTED_CORE_TARGETS.map((target) => [target, portable]));
  assert.doesNotThrow(() => validateDesktopCoreDependencyClosures(metadataByTarget));
});

test('labels a forbidden desktop closure with the target that resolves it', () => {
  const portable = metadataWithCoreClosure([
    ['yaqmc-core', ['rodio']],
    ['rodio', ['cpal']],
    ['cpal', []],
  ]);
  const forbidden = metadataWithCoreClosure([
    ['yaqmc-core', ['portable-layer']],
    ['portable-layer', ['raw-window-handle']],
    ['raw-window-handle', []],
  ]);
  const metadataByTarget = new Map(SUPPORTED_CORE_TARGETS.map((target) => [target, portable]));
  metadataByTarget.set('aarch64-pc-windows-msvc', forbidden);

  assert.throws(
    () => validateDesktopCoreDependencyClosures(metadataByTarget),
    /aarch64-pc-windows-msvc: forbidden yaqmc-core dependency closure: raw-window-handle/,
  );
});

test('rejects a forbidden platform dependency reached transitively from Core', () => {
  assert.throws(
    () =>
      validateCoreDependencyClosure(
        metadataWithCoreClosure([
          ['yaqmc-core', ['portable-layer']],
          ['portable-layer', ['webkit2gtk']],
          ['webkit2gtk', []],
        ]),
      ),
    /forbidden yaqmc-core dependency closure: webkit2gtk/,
  );
});

test('requires Cargo.lock to pin optional qqmusic-api and rejects any other metadata source', () => {
  assert.throws(() => validateQqmusicApiLockPin('name = "other"\n'), /Cargo.lock must pin/);
  assert.doesNotThrow(() =>
    validateQqmusicApiLockPin(
      `name = "qqmusic-api"\nsource = "git+${QM_API_RS_GIT}?rev=${QM_API_RS_REV}#${QM_API_RS_REV}"\n`,
    ),
  );
  assert.doesNotThrow(() =>
    validateQqmusicApiMetadataIfPresent(
      metadataWithTargetDirectory(path.join(repositoryRoot, 'target')),
    ),
  );
  const pinned = metadataWithTargetDirectory(path.join(repositoryRoot, 'target'));
  pinned.packages.push({
    id: `git+${QM_API_RS_GIT}?rev=${QM_API_RS_REV}#qqmusic-api@0.1.0`,
    name: 'qqmusic-api',
    manifest_path: '/tmp/qqmusic-api/Cargo.toml',
  });
  assert.doesNotThrow(() => validateQqmusicApiMetadataIfPresent(pinned));
  const wrongRev = metadataWithTargetDirectory(path.join(repositoryRoot, 'target'));
  wrongRev.packages.push({
    id: 'git+https://github.com/YAQMC/qm-api-rs.git?rev=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef#qqmusic-api',
    name: 'qqmusic-api',
    manifest_path: '/tmp/qqmusic-api/Cargo.toml',
  });
  assert.throws(() => validateQqmusicApiMetadataIfPresent(wrongRev), /must be git/);
});

test('allows the P14 provider boundary in the Core dependency closure', () => {
  assert.doesNotThrow(() =>
    validateCoreDependencyClosure(
      metadataWithCoreClosure([
        ['yaqmc-core', ['portable-layer']],
        ['portable-layer', ['yaqmc-provider-qqmusic']],
        ['yaqmc-provider-qqmusic', []],
      ]),
    ),
  );
});

test('rejects underscore-form forbidden dependencies reached transitively from Core', () => {
  for (const forbidden of ['raw_window_handle', 'qqmusic_api', 'napi_build']) {
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
