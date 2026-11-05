import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  coreSha256,
  FILE_SHA256_V1,
  MACHO_CONTENT_SHA256_V1,
} from '../../apps/desktop/main/core/core-hash.js';
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
  assert.equal(staged.hashMode, FILE_SHA256_V1);
  assert.deepEqual(JSON.parse(readFileSync(path.join(destinationDir, 'manifest.json'), 'utf8')), {
    name,
    sha256: staged.sha256,
    bytes: 'core-bytes'.length,
    hashMode: FILE_SHA256_V1,
  });
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

test('signs unsigned Mach-O before hashing the staged copy and fails closed on signing errors', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-stage-unsigned-macho-'));
  const name = coreBinaryName();
  mkdirSync(path.join(root, 'release'));
  const source = path.join(root, 'release', name);
  const unsigned = Buffer.alloc(160);
  unsigned.writeUInt32LE(0xfeedfacf, 0);
  unsigned.writeUInt32LE(0x01000007, 4);
  writeFileSync(source, unsigned);
  const signed = Buffer.concat([unsigned, Buffer.alloc(64, 0xa1)]);
  signed.writeUInt32LE(1, 16);
  signed.writeUInt32LE(16, 20);
  signed.writeUInt32LE(0x1d, 32);
  signed.writeUInt32LE(16, 36);
  signed.writeUInt32LE(160, 40);
  signed.writeUInt32LE(64, 44);
  const destinationDir = path.join(root, 'out');
  const options = { repoRoot: repositoryRoot, env: { CARGO_TARGET_DIR: root }, destinationDir };
  const staged = stageCore({
    ...options,
    execute(command, args) {
      assert.equal(command, 'codesign');
      assert.deepEqual(args, ['--force', '--sign', '-', path.join(destinationDir, name)]);
      writeFileSync(args[3], signed);
    },
  });
  assert.deepEqual(readFileSync(source), unsigned);
  assert.equal(staged.bytes, signed.length);
  assert.equal(staged.hashMode, MACHO_CONTENT_SHA256_V1);
  assert.equal(staged.sha256, coreSha256(signed, MACHO_CONTENT_SHA256_V1));
  const failedDir = path.join(root, 'failed');
  assert.throws(
    () =>
      stageCore({
        ...options,
        destinationDir: failedDir,
        execute() {
          throw new Error('signing failed');
        },
      }),
    /signing failed/,
  );
  assert.throws(() => readFileSync(path.join(failedDir, 'manifest.json')), { code: 'ENOENT' });
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
