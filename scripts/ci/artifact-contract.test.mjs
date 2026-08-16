import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  ciArtifactNames,
  taggedArtifactNames,
  taggedWorkflowOutputs,
  verifyTaggedArtifactDirectory,
} from './artifact-contract.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const contractScript = path.join(repositoryRoot, 'scripts', 'ci', 'artifact-contract.mjs');

test('generates the unchanged CI staging names for every package architecture', () => {
  const cases = [
    [
      'windows',
      'x86_64',
      {
        releaseDirectory: 'YAQMC-windows-x86_64',
        nsis: 'YAQMC-0.1.0-windows-x86_64-abcdef1-nsis-setup.exe',
        msi: 'YAQMC-0.1.0-windows-x86_64-abcdef1-msi.msi',
        portable: 'YAQMC-0.1.0-windows-x86_64-abcdef1-portable.zip',
        buildInfo: 'build-info.json',
        checksum: 'SHA256SUMS-windows-x86_64.txt',
      },
    ],
    [
      'windows',
      'i686',
      {
        releaseDirectory: 'YAQMC-windows-i686',
        nsis: 'YAQMC-0.1.0-windows-i686-abcdef1-nsis-setup.exe',
        msi: 'YAQMC-0.1.0-windows-i686-abcdef1-msi.msi',
        portable: 'YAQMC-0.1.0-windows-i686-abcdef1-portable.zip',
        buildInfo: 'build-info.json',
        checksum: 'SHA256SUMS-windows-i686.txt',
      },
    ],
    [
      'windows',
      'aarch64',
      {
        releaseDirectory: 'YAQMC-windows-aarch64',
        nsis: 'YAQMC-0.1.0-windows-aarch64-abcdef1-nsis-setup.exe',
        msi: 'YAQMC-0.1.0-windows-aarch64-abcdef1-msi.msi',
        portable: 'YAQMC-0.1.0-windows-aarch64-abcdef1-portable.zip',
        buildInfo: 'build-info.json',
        checksum: 'SHA256SUMS-windows-aarch64.txt',
      },
    ],
    [
      'linux',
      'x86_64',
      {
        releaseDirectory: 'YAQMC-linux-x86_64',
        appImage: 'YAQMC-0.1.0-linux-x86_64-abcdef1.AppImage',
        deb: 'YAQMC-0.1.0-linux-x86_64-abcdef1.deb',
        rpm: 'YAQMC-0.1.0-linux-x86_64-abcdef1.rpm',
        binary: 'YAQMC-0.1.0-linux-x86_64-abcdef1-binary.tar.gz',
        readme: 'README-binary.txt',
        buildInfo: 'build-info.json',
        checksum: 'SHA256SUMS-linux-x86_64.txt',
      },
    ],
    [
      'linux',
      'aarch64',
      {
        releaseDirectory: 'YAQMC-linux-aarch64',
        appImage: 'YAQMC-0.1.0-linux-aarch64-abcdef1.AppImage',
        deb: 'YAQMC-0.1.0-linux-aarch64-abcdef1.deb',
        rpm: 'YAQMC-0.1.0-linux-aarch64-abcdef1.rpm',
        binary: 'YAQMC-0.1.0-linux-aarch64-abcdef1-binary.tar.gz',
        readme: 'README-binary.txt',
        buildInfo: 'build-info.json',
        checksum: 'SHA256SUMS-linux-aarch64.txt',
      },
    ],
  ];

  for (const [platform, arch, expected] of cases) {
    assert.deepEqual(
      ciArtifactNames({ platform, arch, version: '0.1.0', shortSha: 'abcdef1' }),
      expected,
      `${platform}/${arch}`,
    );
  }
});

test('generates unchanged tagged-release package names and preserves Tauri basenames', () => {
  assert.deepEqual(
    taggedArtifactNames({
      platform: 'windows',
      arch: 'i686',
      bundleFilenames: ['YAQMC_0.1.0_x86-setup.exe', 'YAQMC_0.1.0_x86_en-US.msi'],
    }),
    {
      releaseDirectory: 'YAQMC-windows-i686',
      packages: [
        'YAQMC-windows-i686-YAQMC_0.1.0_x86-setup.exe',
        'YAQMC-windows-i686-YAQMC_0.1.0_x86_en-US.msi',
      ],
      portable: 'YAQMC-windows-i686-portable.zip',
      checksum: 'SHA256SUMS-windows-i686.txt',
    },
  );

  assert.deepEqual(
    taggedArtifactNames({
      platform: 'linux',
      arch: 'x86_64',
      bundleFilenames: [
        'YAQMC_0.1.0_amd64.AppImage',
        'YAQMC_0.1.0_amd64.deb',
        'YAQMC-0.1.0.x86_64.rpm',
      ],
    }),
    {
      releaseDirectory: 'YAQMC-linux-x86_64',
      packages: ['YAQMC_0.1.0_amd64.AppImage', 'YAQMC_0.1.0_amd64.deb', 'YAQMC-0.1.0.x86_64.rpm'],
      portable: 'YAQMC-linux-x86_64-portable.tar.gz',
      tester: 'YAQMC-linux-x86_64-tester.tar.gz',
      checksum: 'SHA256SUMS-linux-x86_64.txt',
    },
  );
});

test('generates tagged workflow outputs for every supported architecture', () => {
  const cases = [
    ['windows', 'x86_64', 'YAQMC-windows-x86_64-portable.zip', 'SHA256SUMS-windows-x86_64.txt'],
    ['windows', 'i686', 'YAQMC-windows-i686-portable.zip', 'SHA256SUMS-windows-i686.txt'],
    ['windows', 'aarch64', 'YAQMC-windows-aarch64-portable.zip', 'SHA256SUMS-windows-aarch64.txt'],
    ['linux', 'x86_64', 'YAQMC-linux-x86_64-portable.tar.gz', 'SHA256SUMS-linux-x86_64.txt'],
    ['linux', 'aarch64', 'YAQMC-linux-aarch64-portable.tar.gz', 'SHA256SUMS-linux-aarch64.txt'],
  ];

  for (const [platform, arch, portable, checksum] of cases) {
    const output = taggedWorkflowOutputs({ platform, arch });
    assert.equal(output.releaseDirectory, `YAQMC-${platform}-${arch}`);
    assert.equal(output.portable, portable);
    assert.equal(output.checksum, checksum);
  }
  assert.equal(
    taggedWorkflowOutputs({ platform: 'linux', arch: 'x86_64' }).tester,
    'YAQMC-linux-x86_64-tester.tar.gz',
  );
  assert.equal(taggedWorkflowOutputs({ platform: 'linux', arch: 'aarch64' }).tester, '');
  assert.throws(
    () => taggedWorkflowOutputs({ platform: 'linux', arch: 'i686' }),
    /unsupported artifact target/,
  );
});

test('CLI writes the same tagged contract values consumed by the workflow', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-artifact-contract-'));
  const outputPath = path.join(directory, 'github-output.txt');
  const result = spawnSync(
    process.execPath,
    [contractScript, '--mode', 'tagged', '--platform', 'windows', '--arch', 'aarch64'],
    {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(outputPath, 'utf8'),
    [
      'releaseDirectory=YAQMC-windows-aarch64',
      'portable=YAQMC-windows-aarch64-portable.zip',
      'checksum=SHA256SUMS-windows-aarch64.txt',
      'bundlePrefix=YAQMC-windows-aarch64-',
      'tester=',
      '',
    ].join('\n'),
  );
});

function writeTaggedDirectory(platform, arch) {
  const directory = mkdtempSync(path.join(os.tmpdir(), `yaqmc-tagged-${platform}-${arch}-`));
  const bundleNames =
    platform === 'windows'
      ? ['YAQMC_0.1.0_setup.exe', 'YAQMC_0.1.0_x64_en-US.msi']
      : ['YAQMC_0.1.0_amd64.AppImage', 'YAQMC_0.1.0_amd64.deb', 'YAQMC-0.1.0.x86_64.rpm'];
  const names = taggedArtifactNames({ platform, arch, bundleFilenames: bundleNames });
  const files = [...names.packages, names.portable, ...(names.tester ? [names.tester] : [])];
  for (const filename of files) writeFileSync(path.join(directory, filename), filename);
  writeFileSync(
    path.join(directory, names.checksum),
    files.map((filename) => `${'0'.repeat(64)}  ${filename}`).join('\n') + '\n',
  );
  return { directory, names };
}

test('verifies actual tagged release directories and rejects renamed or uncovered artifacts', () => {
  for (const [platform, arch] of [
    ['windows', 'x86_64'],
    ['windows', 'i686'],
    ['windows', 'aarch64'],
    ['linux', 'x86_64'],
    ['linux', 'aarch64'],
  ]) {
    const { directory } = writeTaggedDirectory(platform, arch);
    assert.deepEqual(verifyTaggedArtifactDirectory({ platform, arch, directory }), {
      platform,
      arch,
      directory,
    });
  }

  const renamed = writeTaggedDirectory('windows', 'x86_64');
  writeFileSync(
    path.join(renamed.directory, renamed.names.portable.replace('portable', 'renamed')),
    'bad',
  );
  writeFileSync(path.join(renamed.directory, renamed.names.portable), '');
  assert.throws(
    () =>
      verifyTaggedArtifactDirectory({
        platform: 'windows',
        arch: 'x86_64',
        directory: renamed.directory,
      }),
    /portable artifact.*empty|unexpected tagged artifact/,
  );

  const uncovered = writeTaggedDirectory('linux', 'aarch64');
  writeFileSync(path.join(uncovered.directory, 'extra.deb'), 'extra');
  assert.throws(
    () =>
      verifyTaggedArtifactDirectory({
        platform: 'linux',
        arch: 'aarch64',
        directory: uncovered.directory,
      }),
    /checksum.*extra\.deb/,
  );

  const cliDirectory = writeTaggedDirectory('linux', 'x86_64');
  const cli = spawnSync(
    process.execPath,
    [
      contractScript,
      '--mode',
      'tagged',
      '--platform',
      'linux',
      '--arch',
      'x86_64',
      '--verify-directory',
      cliDirectory.directory,
    ],
    { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } },
  );
  assert.equal(cli.status, 0, cli.stderr);
});
