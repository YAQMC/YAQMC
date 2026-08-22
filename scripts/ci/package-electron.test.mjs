import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { repositoryRoot } from './repo.mjs';
import {
  cargoBuildArgs,
  electronArtifactNames,
  electronBuilderArgs,
  isElectronCoreCross,
  parseElectronPackageArgs,
  planElectronPackage,
  stageElectronArtifacts,
} from './package-electron.mjs';

const SCRIPT = path.join(repositoryRoot, 'scripts', 'ci', 'package-electron.mjs');
const WORKFLOW = path.join(repositoryRoot, '.github', 'workflows', 'ci.yml');

test('package-electron dry-run prints cargo, stage-core, and --publish never', () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--os', 'windows', '--arch', 'x64', '--target', 'x86_64-pc-windows-msvc', '--dry-run'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.cargo, [
    'cargo',
    'build',
    '-p',
    'yaqmc-core',
    '--release',
    '--locked',
    '--target',
    'x86_64-pc-windows-msvc',
  ]);
  assert.ok(plan.stageCore.includes('--rust-target'));
  assert.ok(plan.stageCore.includes('x86_64-pc-windows-msvc'));
  assert.equal(plan.publish, 'never');
  assert.ok(plan.electronBuilder.includes('--publish'));
  assert.ok(plan.electronBuilder.includes('never'));
  assert.equal(plan.cross, false);
});

test('Windows arm64 is treated as a core cross-compile', () => {
  assert.equal(isElectronCoreCross({ os: 'windows', arch: 'arm64' }), true);
  assert.equal(isElectronCoreCross({ os: 'windows', arch: 'x64' }), false);
  assert.equal(isElectronCoreCross({ os: 'linux', arch: 'arm64' }), false);
  const plan = planElectronPackage({
    os: 'windows',
    arch: 'arm64',
    target: 'aarch64-pc-windows-msvc',
  });
  assert.equal(plan.cross, true);
  assert.ok(plan.electronBuilder.includes('--arm64'));
  assert.ok(plan.electronBuilder.includes('--win'));
  assert.ok(!plan.electronBuilder.includes('--linux'));
});

test('Linux builder args request AppImage deb rpm tar.gz and never publish', () => {
  const args = electronBuilderArgs({ os: 'linux', arch: 'x64' });
  assert.ok(args.includes('--linux'));
  assert.ok(args.includes('AppImage'));
  assert.ok(args.includes('deb'));
  assert.ok(args.includes('rpm'));
  assert.ok(args.includes('tar.gz'));
  assert.ok(args.includes('--x64'));
  assert.deepEqual(args.slice(-2), ['--publish', 'never']);
  assert.deepEqual(cargoBuildArgs('aarch64-unknown-linux-gnu').slice(-2), [
    '--target',
    'aarch64-unknown-linux-gnu',
  ]);
});

test('parseElectronPackageArgs treats --dry-run as a boolean', () => {
  const parsed = parseElectronPackageArgs([
    '--os',
    'linux',
    '--arch',
    'arm64',
    '--target',
    'aarch64-unknown-linux-gnu',
    '--dry-run',
  ]);
  assert.equal(parsed.os, 'linux');
  assert.equal(parsed.arch, 'arm64');
  assert.equal(parsed.target, 'aarch64-unknown-linux-gnu');
  assert.equal(parsed.dryRun, true);
});

test('stages named Electron artifacts and checksums without unpacked trees', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-electron-stage-'));
  for (const name of electronArtifactNames({ os: 'windows', arch: 'x64' })) {
    writeFileSync(path.join(root, name), name);
  }
  writeFileSync(path.join(root, 'latest.yml'), 'version: 0.1.0\n');
  mkdirSync(path.join(root, 'win-unpacked'), { recursive: true });
  writeFileSync(path.join(root, 'win-unpacked', 'YAQMC.exe'), 'unpacked');
  const dest = stageElectronArtifacts({
    repoRoot: root,
    os: 'windows',
    arch: 'x64',
    sourceDir: root,
    buildInfo: {
      target: 'x86_64-pc-windows-msvc',
      profile: 'ci-release',
      lto: 'thin',
      codegenUnits: 8,
      bundles: ['nsis', 'portable'],
    },
  });
  assert.equal(dest, path.join(root, 'YAQMC-electron-windows-x64'));
  assert.equal(
    readFileSync(path.join(dest, 'YAQMC-windows-x64-setup.exe'), 'utf8'),
    'YAQMC-windows-x64-setup.exe',
  );
  assert.equal(readFileSync(path.join(dest, 'latest.yml'), 'utf8'), 'version: 0.1.0\n');
  const buildInfo = JSON.parse(
    readFileSync(path.join(dest, 'build-info-windows-x64.json'), 'utf8'),
  );
  assert.equal(buildInfo.target, 'x86_64-pc-windows-msvc');
  assert.equal(buildInfo.profile, 'ci-release');
  assert.equal(buildInfo.lto, 'thin');
  assert.deepEqual(
    buildInfo.files.map(({ name }) => name),
    ['YAQMC-windows-x64-setup.exe', 'latest.yml'],
  );
  assert.ok(buildInfo.files.every(({ sha256 }) => /^[0-9a-f]{64}$/u.test(sha256)));
  const sums = readFileSync(path.join(dest, 'SHA256SUMS-electron-windows-x64.txt'), 'utf8');
  assert.match(sums, /YAQMC-windows-x64-setup\.exe/);
  assert.match(sums, /build-info-windows-x64\.json/);
  assert.doesNotMatch(sums, /win-unpacked/);
  assert.throws(
    () =>
      stageElectronArtifacts({
        os: 'windows',
        arch: 'x64',
        sourceDir: root,
        buildInfo: {
          target: 'x86_64-pc-windows-msvc',
          profile: 'ci-release',
          lto: 'thin',
          codegenUnits: 8,
          bundles: ['nsis', 'portable'],
        },
      }),
    /refusing to overwrite non-empty Electron package directory/,
  );
});

test('CI uses the Electron package job as the only desktop package path', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /^ {2}electron-package-matrix:/m);
  assert.match(workflow, /^ {2}electron-package:/m);
  assert.doesNotMatch(workflow, /^ {2}package:/m);
  assert.doesNotMatch(workflow, /node scripts\/ci\/package-native\.mjs/);
  assert.match(workflow, /node scripts\/ci\/package-electron\.mjs/);
  assert.match(workflow, /node scripts\/ci\/select-electron-package-matrix\.mjs/);
  assert.match(
    workflow,
    /YAQMC-electron-\$\{\{ matrix\.os \}\}-\$\{\{ matrix\.arch \}\}-\$\{\{ github\.sha \}\}/,
  );
  const electronJob = workflow.split(/^ {2}electron-package:/m)[1]?.split(/^ {2}[a-z]/m)[0] ?? '';
  assert.match(electronJob, /YAQMC_PREBUILT_FRONTEND: '1'/);
  assert.match(electronJob, /continue-on-error:\s*false/);
  assert.match(electronJob, /setup-packaging/);
  assert.match(electronJob, /qm-api-rs-token:/);
  assert.match(electronJob, /secrets\.QM_API_RS_TOKEN/);
  assert.doesNotMatch(electronJob, /webkit/i);
  assert.match(electronJob, /rpm fakeroot/);
  assert.match(electronJob, /node scripts\/ci\/stage-linux-tester\.mjs/);
  assert.match(electronJob, /--identity-only/);
  assert.match(electronJob, /YAQMC-linux-x64-tester-\$\{\{ github\.sha \}\}/);
  assert.match(readFileSync(SCRIPT, 'utf8'), /'--publish', 'never'/);
  assert.doesNotMatch(electronJob, /--publish always/);
  assert.doesNotMatch(workflow, /autoDownload:\s*true/);
});
