import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { coreSha256, MACHO_CONTENT_SHA256_V1 } from '../../apps/desktop/main/core/core-hash.js';
import {
  codesignDetails,
  parseCodesignDetails,
  signaturePolicyProblems,
  verifyCoreManifest,
} from './verify-macos-package.mjs';

function signedMachO(signatureSize, signatureByte) {
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

const ADHOC = `Executable=/tmp/YAQMC.app/Contents/MacOS/YAQMC
Identifier=org.yaqmc.desktop
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=1234 flags=0x20002(adhoc,linker-signed) hashes=30+7 location=embedded
Signature=adhoc
Info.plist entries=30
TeamIdentifier=not set
Sealed Resources version=2 rules=13 files=40
`;

const DEVELOPER_ID = `Executable=/tmp/YAQMC.app/Contents/MacOS/YAQMC
Identifier=org.yaqmc.desktop
Format=app bundle with Mach-O thin (x86_64)
CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=30+7 location=embedded
Signature size=9000
Authority=Developer ID Application: Example Maintainer (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Nov 4, 2026 at 10:00:00
TeamIdentifier=ABCDE12345
`;

test('codesign inspection reads successful stderr and rejects execution failures', () => {
  const appPath = '/tmp/package with spaces/YAQMC.app';
  const output = codesignDetails(appPath, (command, args, options) => {
    assert.equal(command, 'codesign');
    assert.deepEqual(args, ['-dv', '--verbose=2', appPath]);
    assert.equal(options.encoding, 'utf8');
    return { status: 0, stdout: '', stderr: ADHOC };
  });
  assert.deepEqual(signaturePolicyProblems(parseCodesignDetails(output), { signed: false }), []);
  assert.throws(
    () => codesignDetails(appPath, () => ({ status: 1, stdout: '', stderr: 'not signed' })),
    /codesign -dv failed: not signed/,
  );
  const error = new Error('spawn codesign ENOENT');
  assert.throws(() => codesignDetails(appPath, () => ({ status: null, error })), {
    message: 'codesign -dv failed: spawn codesign ENOENT',
    cause: error,
  });
});

test('parses ad-hoc and Developer ID codesign output', () => {
  assert.deepEqual(parseCodesignDetails(ADHOC), {
    identifier: 'org.yaqmc.desktop',
    adhoc: true,
    teamIdentifier: null,
    developerId: false,
    hardenedRuntime: false,
  });
  assert.deepEqual(parseCodesignDetails(DEVELOPER_ID), {
    identifier: 'org.yaqmc.desktop',
    adhoc: false,
    teamIdentifier: 'ABCDE12345',
    developerId: true,
    hardenedRuntime: true,
  });
});

test('unsigned builds must be ad-hoc; signed builds must be Developer ID with hardened runtime', () => {
  assert.deepEqual(signaturePolicyProblems(parseCodesignDetails(ADHOC), { signed: false }), []);
  assert.deepEqual(
    signaturePolicyProblems(parseCodesignDetails(DEVELOPER_ID), { signed: true }),
    [],
  );
  assert.match(
    signaturePolicyProblems(parseCodesignDetails(ADHOC), { signed: true }).join('\n'),
    /ad-hoc signature[\s\S]*Developer ID[\s\S]*Team ID[\s\S]*hardened runtime/u,
  );
  const unsigned = 'Identifier=org.yaqmc.desktop\nTeamIdentifier=not set\n';
  assert.match(
    signaturePolicyProblems(parseCodesignDetails(unsigned), { signed: false })[0],
    /must be ad-hoc/u,
  );
  assert.match(
    signaturePolicyProblems(parseCodesignDetails('Identifier=com.github.Electron\n'), {
      signed: false,
    }).join(),
    /unexpected bundle identifier/u,
  );
});

test('package verification accepts re-signed Mach-O content and rejects code tampering', () => {
  const resources = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-macos-core-'));
  const coreDir = path.join(resources, 'core');
  mkdirSync(coreDir);
  const staged = signedMachO(64, 0xa1);
  const packaged = signedMachO(96, 0xb2);
  const binary = path.join(coreDir, 'yaqmc-core');
  writeFileSync(binary, packaged);
  writeFileSync(
    path.join(coreDir, 'manifest.json'),
    `${JSON.stringify({
      name: 'yaqmc-core',
      sha256: coreSha256(staged, MACHO_CONTENT_SHA256_V1),
      bytes: staged.length,
      hashMode: MACHO_CONTENT_SHA256_V1,
    })}\n`,
  );
  assert.equal(verifyCoreManifest(resources).hashMode, MACHO_CONTENT_SHA256_V1);
  const tampered = readFileSync(binary);
  tampered[140] ^= 0xff;
  writeFileSync(binary, tampered);
  assert.throws(() => verifyCoreManifest(resources), /packaged Core hash mismatch/u);
});
