import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  readCargoPackageVersion,
  readRootVersion,
  syncVersions,
  workspaceCrateManifests,
} from '../sync-version.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function writeMiniRepo(root, versions) {
  mkdirSync(path.join(root, 'apps', 'desktop'), { recursive: true });
  mkdirSync(path.join(root, 'crates', 'yaqmc-core'), { recursive: true });
  writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'yaqmc', version: versions.root }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(root, 'apps', 'desktop', 'package.json'),
    `${JSON.stringify({ name: '@yaqmc/desktop', version: versions.desktop }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(root, 'Cargo.toml'),
    `[workspace]\nmembers = [\n    "crates/yaqmc-core",\n]\n`,
  );
  writeFileSync(
    path.join(root, 'crates', 'yaqmc-core', 'Cargo.toml'),
    `[package]\nname = "yaqmc-core"\nversion = "${versions.core}"\nedition = "2021"\n`,
  );
}

test('root package.json declares the sync-version script', () => {
  const pkg = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['sync-version'], 'node scripts/sync-version.mjs');
  assert.equal(pkg.version, '0.1.0');
});

test('check mode accepts the live repo when versions already match 0.1.0', () => {
  const result = syncVersions({ repoRoot: repositoryRoot, check: true });
  assert.equal(result.version, '0.1.0');
  assert.equal(readRootVersion(repositoryRoot), '0.1.0');
  assert.equal(result.updates.length, 0);
  for (const manifest of workspaceCrateManifests(repositoryRoot)) {
    assert.equal(readCargoPackageVersion(readFileSync(manifest, 'utf8')), '0.1.0');
  }
});

test('check/dry-run fails when desktop package.json differs from root', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-sync-version-desktop-'));
  writeMiniRepo(root, {
    root: '0.1.0',
    desktop: '9.9.9',
    core: '0.1.0',
  });
  assert.throws(
    () => syncVersions({ repoRoot: root, check: true }),
    /apps\/desktop\/package.json: 9\.9\.9 != 0\.1\.0/,
  );
  assert.equal(
    JSON.parse(readFileSync(path.join(root, 'apps', 'desktop', 'package.json'), 'utf8')).version,
    '9.9.9',
  );
});

test('check/dry-run fails when a workspace crate differs from root', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-sync-version-crate-'));
  writeMiniRepo(root, {
    root: '0.1.0',
    desktop: '0.1.0',
    core: '0.2.0',
  });
  assert.throws(
    () => syncVersions({ repoRoot: root, check: true }),
    /crates\/yaqmc-core\/Cargo.toml: 0\.2\.0 != 0\.1\.0/,
  );
});

test('write mode copies the root version and no-ops files that already match', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-sync-version-write-'));
  writeMiniRepo(root, {
    root: '0.1.0',
    desktop: '0.0.9',
    core: '0.0.8',
  });
  const result = syncVersions({ repoRoot: root });
  assert.equal(result.version, '0.1.0');
  assert.equal(result.updates.length, 2);
  assert.equal(
    JSON.parse(readFileSync(path.join(root, 'apps', 'desktop', 'package.json'), 'utf8')).version,
    '0.1.0',
  );
  assert.equal(
    readCargoPackageVersion(
      readFileSync(path.join(root, 'crates', 'yaqmc-core', 'Cargo.toml'), 'utf8'),
    ),
    '0.1.0',
  );
});

test('already-matching trees are a no-op write', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-sync-version-noop-'));
  writeMiniRepo(root, {
    root: '0.1.0',
    desktop: '0.1.0',
    core: '0.1.0',
  });
  const files = [
    path.join(root, 'apps', 'desktop', 'package.json'),
    path.join(root, 'crates', 'yaqmc-core', 'Cargo.toml'),
  ];
  const before = files.map((filePath) => readFileSync(filePath));
  const result = syncVersions({ repoRoot: root });
  assert.equal(result.updates.length, 0);
  for (const [index, filePath] of files.entries()) {
    assert.deepEqual(readFileSync(filePath), before[index]);
  }
});
