import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectBinaryArchitecture, verifyBinaryFile } from './verify-binary-arch.mjs';

function elf(machine) {
  const bytes = Buffer.alloc(64);
  bytes[0] = 0x7f;
  bytes[1] = 0x45;
  bytes[2] = 0x4c;
  bytes[3] = 0x46;
  bytes[18] = machine & 0xff;
  bytes[19] = (machine >> 8) & 0xff;
  return bytes;
}

function pe(machine) {
  const bytes = Buffer.alloc(0x48);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  bytes[0x3c] = 0x40;
  bytes[0x40] = 0x50;
  bytes[0x41] = 0x45;
  bytes[0x44] = machine & 0xff;
  bytes[0x45] = (machine >> 8) & 0xff;
  return bytes;
}

test('inspects ELF and PE architectures', () => {
  assert.equal(inspectBinaryArchitecture(elf(62)).arch, 'x86_64');
  assert.equal(inspectBinaryArchitecture(elf(183)).arch, 'aarch64');
  assert.equal(inspectBinaryArchitecture(pe(0x8664)).arch, 'x86_64');
  assert.equal(inspectBinaryArchitecture(pe(0x14c)).arch, 'i686');
  assert.equal(inspectBinaryArchitecture(pe(0xaa64)).arch, 'aarch64');
});

test('rejects an architecture mismatch', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-arch-'));
  const file = path.join(directory, 'yaqmc');
  writeFileSync(file, elf(62));
  assert.throws(
    () => verifyBinaryFile(file, 'aarch64-unknown-linux-gnu'),
    /is x86_64, expected aarch64/,
  );
});

function macho(cpuType) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(cpuType, 4);
  return bytes;
}

test('inspects thin Mach-O architectures for both macOS targets', () => {
  assert.deepEqual(inspectBinaryArchitecture(macho(0x01000007)), {
    format: 'macho',
    arch: 'x86_64',
    machine: 0x01000007,
  });
  assert.equal(inspectBinaryArchitecture(macho(0x0100000c)).arch, 'aarch64');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-macho-'));
  const file = path.join(directory, 'yaqmc-core');
  writeFileSync(file, macho(0x0100000c));
  assert.equal(verifyBinaryFile(file, 'aarch64-apple-darwin').format, 'macho');
  assert.throws(() => verifyBinaryFile(file, 'x86_64-apple-darwin'), /is aarch64, expected x86_64/);
});

test('rejects universal Mach-O binaries and unknown CPU types', () => {
  const fat = Buffer.alloc(32);
  fat.writeUInt32BE(0xcafebabe, 0);
  assert.throws(() => inspectBinaryArchitecture(fat), /universal \(fat\) Mach-O/);
  assert.throws(() => inspectBinaryArchitecture(macho(0x00000012)), /unsupported Mach-O cputype/);
});
