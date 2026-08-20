import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { repositoryRoot } from './repo.mjs';
import {
  APP_ID,
  BUILDER_VERSION,
  CLEAN_VM_STATE,
  ELECTRON_VERSION,
  LINUX_ARCHES,
  LINUX_TARGETS,
  PACK03_ID,
  TRAY_RECOMMENDS_DEB,
  TRAY_RECOMMENDS_RPM,
  UPDATER_BEARING_TARGET,
  executeLinuxPack,
  linuxArtifactName,
  linuxDataDir,
  linuxInstallCommand,
  linuxUninstallCommand,
  pack03Report,
  packLinuxCommand,
  parseBuilderLinux,
} from '../migration/pack03-linux.mjs';

const SCRIPT = path.join(repositoryRoot, 'scripts', 'migration', 'pack03-linux.mjs');

test('PACK-03 assist prints a pending clean-VM matrix and does not invent green', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.id, PACK03_ID);
  assert.equal(payload.unsigned, true);
  assert.equal(payload.risk, 'R-9');
  assert.equal(payload.electron, ELECTRON_VERSION);
  assert.equal(payload.electronBuilder, BUILDER_VERSION);
  assert.equal(payload.appId, APP_ID);
  assert.equal(payload.updaterBearingTarget, UPDATER_BEARING_TARGET);
  assert.equal(payload.trayFailureNonFatal, true);
  assert.equal(payload.trayRecommends.hardDepends, false);
  assert.equal(payload.trayRecommends.deb, TRAY_RECOMMENDS_DEB);
  assert.equal(payload.trayRecommends.rpm, TRAY_RECOMMENDS_RPM);
  assert.equal(payload.electronUpdater, true);
  assert.equal(payload.canProduceLinuxArtifacts, process.platform === 'linux');
  for (const key of [
    'appImageInstall',
    'debInstall',
    'rpmInstall',
    'tarGzInstall',
    'upgradeAB',
    'uninstall',
    'trayAyatanaNonFatal',
    'x64',
    'arm64',
  ]) {
    assert.equal(payload.Linux[key].state, CLEAN_VM_STATE);
    assert.equal(payload.Linux[key].checked, false);
  }
  assert.doesNotMatch(result.stdout, /"checked":\s*true/);
  assert.match(result.stdout, /LIVE VERIFY pending/);
});

test('yml declares AppImage deb rpm tar.gz for x64 and arm64 without an updater dep', () => {
  const yaml = readFileSync(
    path.join(repositoryRoot, 'apps', 'desktop', 'electron-builder.yml'),
    'utf8',
  );
  const flags = parseBuilderLinux(yaml);
  assert.equal(flags.appId, true);
  assert.equal(flags.linuxSection, true);
  assert.deepEqual(flags.targets, LINUX_TARGETS);
  assert.deepEqual(flags.arches, LINUX_ARCHES);
  assert.equal(flags.appImage, true);
  assert.equal(flags.deb, true);
  assert.equal(flags.rpm, true);
  assert.equal(flags.tarGz, true);
  assert.equal(flags.x64, true);
  assert.equal(flags.arm64, true);
  assert.equal(flags.artifactName, true);
  assert.equal(flags.updaterBearingAppImage, true);
  assert.equal(flags.webkitGtkDepends, false);
  assert.equal(flags.hasElectronUpdater, false);
  assert.equal(flags.forceCodeSigningFalse, true);
  assert.equal(flags.electronVersion, true);

  const pkg = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'apps', 'desktop', 'package.json'), 'utf8'),
  );
  assert.equal(pkg.devDependencies.electron, ELECTRON_VERSION);
  assert.equal(pkg.devDependencies['electron-builder'], BUILDER_VERSION);
  assert.equal(pkg.dependencies?.['electron-updater'], '6.8.6');
});

test('prints electron-builder --linux flags from the yml and POSIX install commands', () => {
  assert.equal(
    packLinuxCommand('x64'),
    'electron-builder --projectDir . --config electron-builder.yml --linux AppImage deb rpm tar.gz --x64',
  );
  assert.equal(
    packLinuxCommand('arm64'),
    'electron-builder --projectDir . --config electron-builder.yml --linux AppImage deb rpm tar.gz --arm64',
  );
  assert.equal(linuxArtifactName('AppImage', 'x64'), 'YAQMC-linux-x64.AppImage');
  assert.equal(linuxArtifactName('deb', 'arm64'), 'YAQMC-linux-arm64.deb');
  assert.equal(linuxArtifactName('rpm', 'x64'), 'YAQMC-linux-x64.rpm');
  assert.equal(linuxArtifactName('tar.gz', 'x64'), 'YAQMC-linux-x64.tar.gz');

  const deb = '/tmp/release-electron/YAQMC-linux-x64.deb';
  assert.equal(linuxInstallCommand('deb', deb), `sudo apt install '${deb}'`);
  assert.match(linuxUninstallCommand('deb', deb), /dpkg-deb -f/);
  assert.match(linuxInstallCommand('AppImage', '/tmp/YAQMC.AppImage'), /chmod \+x/);
  assert.equal(
    linuxDataDir({ env: { XDG_DATA_HOME: '/tmp/xdg-data' } }),
    '/tmp/xdg-data/org.yaqmc.desktop',
  );

  const report = pack03Report({
    repoRoot: repositoryRoot,
    env: { HOME: '/home/scratch' },
    now: () => '2026-08-17',
    platform: 'win32',
  });
  assert.equal(report.date, '2026-08-17');
  assert.equal(report.dataDir, '/home/scratch/.local/share/org.yaqmc.desktop');
  assert.equal(report.canProduceLinuxArtifacts, false);
  assert.equal(report.artifacts['AppImage-x64'].name, 'YAQMC-linux-x64.AppImage');
  assert.match(report.commands.packLinuxX64, /--linux AppImage deb rpm tar.gz --x64/);
  assert.match(report.commands.packLinuxArm64, /--linux AppImage deb rpm tar.gz --arm64/);
});

test('dry-run does not fail when this host cannot produce Linux artifacts', () => {
  const spawned = [];
  const result = executeLinuxPack({
    repoRoot: repositoryRoot,
    platform: 'win32',
    spawn: (...args) => {
      spawned.push(args);
      return { status: 1, stdout: '', stderr: 'should not spawn' };
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.attempted, false);
  assert.equal(result.status, 0);
  assert.equal(spawned.length, 0);
  assert.match(result.reason, /Linux builder/);

  const cli = spawnSync(process.execPath, [SCRIPT, '--execute'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const payload = JSON.parse(cli.stdout);
  if (process.platform === 'win32') {
    assert.equal(payload.execute.skipped, true);
    assert.equal(payload.execute.status, 0);
  } else {
    assert.equal(payload.execute.ok, true);
  }
});

test('checklist doc does not claim the clean-VM matrix green', () => {
  const doc = readFileSync(
    path.join(repositoryRoot, 'docs', 'migration', 'pack03-linux.md'),
    'utf8',
  );
  assert.match(doc, /LIVE VERIFY \/ clean-VM pending/);
  assert.match(doc, /PACK-03 is not\s+green/);
  assert.match(doc, /updater-bearing per\s+plan §32/);
  assert.match(doc, /libayatana-appindicator/);
  assert.match(doc, /non-fatal/);
  assert.match(doc, /Unsigned \(\*\*R-9\*\*\)/);
  assert.match(doc, /Upgrade \(install A then B\)/);
  assert.match(doc, /AppImage/);
  assert.match(doc, /\bdeb\b/);
  assert.match(doc, /\brpm\b/);
  assert.match(doc, /tar\.gz/);
  assert.match(doc, /x64/);
  assert.match(doc, /arm64/);
  assert.doesNotMatch(doc, /matrix is green/i);
});
