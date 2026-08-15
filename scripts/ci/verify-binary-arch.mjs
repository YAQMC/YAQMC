import { readFileSync } from 'node:fs';

const PE_MACHINE = {
  0x14c: 'i686',
  0x8664: 'x86_64',
  0xaa64: 'aarch64',
};

const ELF_MACHINE = {
  3: 'i686',
  62: 'x86_64',
  183: 'aarch64',
};

const TARGET_ARCH = {
  'i686-pc-windows-msvc': 'i686',
  'x86_64-pc-windows-msvc': 'x86_64',
  'aarch64-pc-windows-msvc': 'aarch64',
  'i686-unknown-linux-gnu': 'i686',
  'x86_64-unknown-linux-gnu': 'x86_64',
  'aarch64-unknown-linux-gnu': 'aarch64',
};

export function inspectBinaryArchitecture(bytes) {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  ) {
    const machine = bytes[18] | (bytes[19] << 8);
    const arch = ELF_MACHINE[machine];
    if (!arch) throw new Error(`unsupported ELF e_machine 0x${machine.toString(16)}`);
    return { format: 'elf', arch, machine };
  }
  if (bytes.length >= 0x40 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const peOffset = bytes[0x3c] | (bytes[0x3d] << 8) | (bytes[0x3e] << 16) | (bytes[0x3f] << 24);
    if (peOffset + 6 > bytes.length) throw new Error('PE header is truncated');
    if (
      bytes[peOffset] !== 0x50 ||
      bytes[peOffset + 1] !== 0x45 ||
      bytes[peOffset + 2] !== 0 ||
      bytes[peOffset + 3] !== 0
    ) {
      throw new Error('MZ file is missing a PE signature');
    }
    const machine = bytes[peOffset + 4] | (bytes[peOffset + 5] << 8);
    const arch = PE_MACHINE[machine];
    if (!arch) throw new Error(`unsupported PE Machine 0x${machine.toString(16)}`);
    return { format: 'pe', arch, machine };
  }
  throw new Error('file is neither a PE nor an ELF binary');
}

export function expectedArchForTarget(target) {
  const arch = TARGET_ARCH[target];
  if (!arch) throw new Error(`unknown target triple ${target}`);
  return arch;
}

export function verifyBinaryFile(filePath, target) {
  const bytes = readFileSync(filePath);
  const actual = inspectBinaryArchitecture(bytes);
  const expected = expectedArchForTarget(target);
  if (actual.arch !== expected) {
    throw new Error(`${filePath} is ${actual.arch}, expected ${expected} for ${target}`);
  }
  return actual;
}

const invokedDirectly = process.argv[1] && process.argv.includes('--file');
if (invokedDirectly) {
  const fileIndex = process.argv.indexOf('--file');
  const targetIndex = process.argv.indexOf('--target');
  const file = process.argv[fileIndex + 1];
  const target = process.argv[targetIndex + 1];
  if (!file || !target) {
    process.stderr.write('usage: verify-binary-arch.mjs --file <path> --target <triple>\n');
    process.exit(1);
  }
  const actual = verifyBinaryFile(file, target);
  process.stdout.write(`${file}: ${actual.format} ${actual.arch}\n`);
}
