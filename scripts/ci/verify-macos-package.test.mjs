import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codesignDetails,
  parseCodesignDetails,
  signaturePolicyProblems,
} from './verify-macos-package.mjs';

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
