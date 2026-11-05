import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CoreIntegrityError, parseCoreManifest, sha256File, verifyCoreBinary } from './integrity';
import {
  coreSha256,
  FILE_SHA256_V1,
  MACHO_CONTENT_SHA256_V1,
  type CoreHashMode,
} from './core-hash.js';

function stagedBinary(contents: string | Buffer) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-integrity-'));
  mkdirSync(dir, { recursive: true });
  const name = process.platform === 'win32' ? 'yaqmc-core.exe' : 'yaqmc-core';
  const binary = path.join(dir, name);
  writeFileSync(binary, contents);
  return { dir, name, binary };
}

function writeManifest(
  dir: string,
  name: string,
  sha256: string,
  bytes: number,
  hashMode?: CoreHashMode,
) {
  writeFileSync(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify({ name, sha256, bytes, ...(hashMode ? { hashMode } : {}) }, null, 2)}\n`,
  );
}

function signedMachO(signatureSize: number, signatureByte: number): Buffer {
  const signatureOffset = 160;
  const bytes = Buffer.alloc(signatureOffset + signatureSize);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(2, 16);
  bytes.writeUInt32LE(88, 20);
  bytes.writeUInt32LE(0x19, 32);
  bytes.writeUInt32LE(72, 36);
  bytes.write('__LINKEDIT', 40, 'ascii');
  bytes.writeBigUInt64LE(BigInt(64 + signatureSize), 64);
  bytes.writeBigUInt64LE(120n, 72);
  bytes.writeBigUInt64LE(BigInt(40 + signatureSize), 80);
  bytes.writeUInt32LE(0x1d, 104);
  bytes.writeUInt32LE(16, 108);
  bytes.writeUInt32LE(signatureOffset, 112);
  bytes.writeUInt32LE(signatureSize, 116);
  bytes.fill(0x42, 120, signatureOffset);
  bytes.fill(signatureByte, signatureOffset);
  return bytes;
}

describe('core spawn-time sha256 verify', () => {
  it('accepts a staged binary that matches its manifest', () => {
    const { dir, name, binary } = stagedBinary('core-bytes');
    const sha256 = sha256File(binary);
    writeManifest(dir, name, sha256, 'core-bytes'.length);
    expect(verifyCoreBinary(binary, 'required')).toEqual({
      name,
      sha256,
      bytes: 'core-bytes'.length,
      hashMode: FILE_SHA256_V1,
    });
  });

  it('accepts a Mach-O whose code signature was replaced after staging', () => {
    const staged = signedMachO(64, 0xa1);
    const packaged = signedMachO(96, 0xb2);
    const { dir, name, binary } = stagedBinary(packaged);
    const sha256 = coreSha256(staged, MACHO_CONTENT_SHA256_V1);
    writeManifest(dir, name, sha256, staged.length, MACHO_CONTENT_SHA256_V1);
    expect(verifyCoreBinary(binary, 'required')).toEqual({
      name,
      sha256,
      bytes: staged.length,
      hashMode: MACHO_CONTENT_SHA256_V1,
    });
  });

  it('rejects Mach-O content tampering outside the code signature', () => {
    const staged = signedMachO(64, 0xa1);
    const packaged = signedMachO(96, 0xb2);
    packaged[140] ^= 0xff;
    const { dir, name, binary } = stagedBinary(packaged);
    writeManifest(
      dir,
      name,
      coreSha256(staged, MACHO_CONTENT_SHA256_V1),
      staged.length,
      MACHO_CONTENT_SHA256_V1,
    );
    expect(() => verifyCoreBinary(binary, 'required')).toThrow(/sha256 mismatch/u);
  });

  it('rejects a flipped byte against the recorded hash', () => {
    const { dir, name, binary } = stagedBinary(Buffer.from('core-bytes'));
    const sha256 = sha256File(binary);
    writeManifest(dir, name, sha256, 10);
    const tampered = Buffer.from('core-bytes');
    tampered[0] = tampered[0] === 0x63 ? 0x43 : 0x63;
    writeFileSync(binary, tampered);
    expect(() => verifyCoreBinary(binary, 'required')).toThrow(CoreIntegrityError);
    expect(() => verifyCoreBinary(binary, 'required')).toThrow(/sha256 mismatch/u);
  });

  it('rejects a wrong hash in the manifest', () => {
    const { dir, name, binary } = stagedBinary('core-bytes');
    const other = createHash('sha256').update('other').digest('hex');
    writeManifest(dir, name, other, 'core-bytes'.length);
    expect(() => verifyCoreBinary(binary, 'required')).toThrow(/sha256 mismatch/u);
  });

  it('fails closed when a staged/packaged binary has no manifest', () => {
    const { binary } = stagedBinary('core-bytes');
    expect(() => verifyCoreBinary(binary, 'required')).toThrow(/missing sha256 manifest/u);
  });

  it('allows an unsigned cargo debug binary without a manifest', () => {
    const { binary } = stagedBinary('debug-core');
    expect(verifyCoreBinary(binary, 'optional')).toBeUndefined();
  });

  it('still verifies a cargo binary when a manifest is present', () => {
    const { dir, name, binary } = stagedBinary('debug-core');
    writeManifest(dir, name, createHash('sha256').update('nope').digest('hex'), 10);
    expect(() => verifyCoreBinary(binary, 'optional')).toThrow(/sha256 mismatch/u);
  });

  it('rejects a malformed manifest object', () => {
    expect(() => parseCoreManifest({ name: 'x' })).toThrow(CoreIntegrityError);
    expect(() =>
      parseCoreManifest({ name: 'x', sha256: '0'.repeat(64), bytes: 1, hashMode: 'future' }),
    ).toThrow(/unsupported hash mode/u);
  });
});
