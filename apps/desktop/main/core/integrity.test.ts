import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CoreIntegrityError,
  parseCoreManifest,
  sha256File,
  verifyCoreBinary,
} from './integrity';

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
) {
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({ name, sha256, bytes }, null, 2)}\n`);
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
    });
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
  });
});
