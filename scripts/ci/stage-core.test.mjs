import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { coreBinaryName, findCoreBinary, stageCore } from '../stage-core.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('stages the cargo binary and writes a sha256 manifest', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-stage-core-'));
  const name = coreBinaryName();
  const debugDir = path.join(root, 'debug');
  mkdirSync(debugDir, { recursive: true });
  writeFileSync(path.join(debugDir, name), 'core-bytes');
  const destinationDir = path.join(root, 'out');
  const staged = stageCore({
    repoRoot: repositoryRoot,
    env: { CARGO_TARGET_DIR: root },
    destinationDir,
    profile: 'debug',
  });
  assert.equal(staged.destination, path.join(destinationDir, name));
  assert.equal(readFileSync(staged.destination, 'utf8'), 'core-bytes');
  assert.equal(staged.bytes, 'core-bytes'.length);
  assert.match(staged.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    readFileSync(path.join(destinationDir, 'core.sha256'), 'utf8'),
    `${staged.sha256}  ${name}\n`,
  );
});

test('prefers release over debug when staging without a profile', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-stage-core-rel-'));
  const name = coreBinaryName();
  mkdirSync(path.join(root, 'debug'), { recursive: true });
  mkdirSync(path.join(root, 'release'), { recursive: true });
  writeFileSync(path.join(root, 'debug', name), 'debug');
  writeFileSync(path.join(root, 'release', name), 'release');
  assert.equal(
    findCoreBinary({ repoRoot: repositoryRoot, env: { CARGO_TARGET_DIR: root } }),
    path.join(root, 'release', name),
  );
});

test('prefers target/<triple>/release when rustTarget is set', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-stage-core-triple-'));
  const name = coreBinaryName();
  const triple = 'aarch64-pc-windows-msvc';
  mkdirSync(path.join(root, 'release'), { recursive: true });
  mkdirSync(path.join(root, triple, 'release'), { recursive: true });
  writeFileSync(path.join(root, 'release', name), 'host');
  writeFileSync(path.join(root, triple, 'release', name), 'cross');
  assert.equal(
    findCoreBinary({
      repoRoot: repositoryRoot,
      env: { CARGO_TARGET_DIR: root },
      profile: 'release',
      rustTarget: triple,
    }),
    path.join(root, triple, 'release', name),
  );
});
