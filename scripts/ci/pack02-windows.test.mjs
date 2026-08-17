import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { repositoryRoot } from './repo.mjs';
import {
  APP_ID, BUILDER_VERSION, CLEAN_VM_STATE, ELECTRON_VERSION, NSIS, PACK02_ID,
  nsisArtifactName, nsisInstallCommand, nsisUninstallCommand, pack02Report,
  packWinScript, parseBuilderNsis, portableArtifactName,
} from '../migration/pack02-windows.mjs';

const SCRIPT = path.join(repositoryRoot, 'scripts', 'migration', 'pack02-windows.mjs');

test('PACK-02 assist prints a pending clean-VM matrix and does not invent green', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.id, PACK02_ID);
  assert.equal(payload.unsigned, true);
  assert.equal(payload.risk, 'R-9');
  assert.equal(payload.electron, ELECTRON_VERSION);
  assert.equal(payload.electronBuilder, BUILDER_VERSION);
  assert.equal(payload.appId, APP_ID);
  assert.equal(payload.nsis.oneClick, false);
  assert.equal(payload.nsis.perMachine, false);
  assert.equal(payload.electronUpdater, false);
  for (const key of ['nsisPerUserInstall', 'portableExe', 'upgradeAB', 'uninstall', 'x64', 'arm64']) {
    assert.equal(payload.Windows[key].state, CLEAN_VM_STATE);
    assert.equal(payload.Windows[key].checked, false);
  }
  assert.doesNotMatch(result.stdout, /"checked":\s*true/);
  assert.match(result.stdout, /LIVE VERIFY pending/);
});

test('pack:win is --win --x64 and NSIS stays per-user', () => {
  const pkg = JSON.parse(readFileSync(path.join(repositoryRoot, 'apps', 'desktop', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['pack:win'], packWinScript());
  assert.match(pkg.scripts['pack:win'], /--win/);
  assert.match(pkg.scripts['pack:win'], /--x64/);
  assert.doesNotMatch(pkg.scripts['pack:win'], /--arm64/);
  assert.equal(pkg.devDependencies.electron, ELECTRON_VERSION);
  assert.equal(pkg.dependencies?.['electron-updater'], undefined);
  assert.equal(pkg.devDependencies?.['electron-updater'], undefined);
  const yaml = readFileSync(path.join(repositoryRoot, 'apps', 'desktop', 'electron-builder.yml'), 'utf8');
  const flags = parseBuilderNsis(yaml);
  assert.equal(flags.appId, true);
  assert.equal(flags.oneClickFalse, true);
  assert.equal(flags.perMachineFalse, true);
  assert.equal(flags.nsisTarget, true);
  assert.equal(flags.portableTarget, true);
  assert.equal(flags.forceCodeSigningFalse, true);
  assert.equal(flags.hasElectronUpdater, false);
  assert.equal(NSIS.oneClick, false);
  assert.equal(NSIS.perMachine, false);
});

test('artifact names and silent per-user install/uninstall commands', () => {
  assert.equal(nsisArtifactName('x64'), 'YAQMC-windows-x64-setup.exe');
  assert.equal(portableArtifactName('x64'), 'YAQMC-windows-x64-portable.exe');
  assert.equal(nsisArtifactName('arm64'), 'YAQMC-windows-arm64-setup.exe');
  const setup = 'C:\\out\\YAQMC-windows-x64-setup.exe';
  const dir = 'C:\\Users\\scratch\\AppData\\Local\\Programs\\YAQMC';
  assert.equal(nsisInstallCommand(setup, { dir }), `"${setup}" /S /D=${dir}`);
  assert.equal(nsisUninstallCommand(dir), `"${dir}\\Uninstall YAQMC.exe" /S`);
  const report = pack02Report({
    repoRoot: repositoryRoot,
    env: { APPDATA: 'C:\\Users\\scratch\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\scratch\\AppData\\Local' },
    now: () => '2026-08-17',
  });
  assert.equal(report.dataDir, 'C:\\Users\\scratch\\AppData\\Roaming\\org.yaqmc.desktop');
  assert.equal(report.perUserInstallDir, 'C:\\Users\\scratch\\AppData\\Local\\Programs\\YAQMC');
  assert.equal(report.artifacts['nsis-x64'].name, 'YAQMC-windows-x64-setup.exe');
  assert.equal(report.date, '2026-08-17');
});

test('checklist doc does not claim the clean-VM matrix green', () => {
  const doc = readFileSync(path.join(repositoryRoot, 'docs', 'migration', 'pack02-windows.md'), 'utf8');
  assert.match(doc, /LIVE VERIFY \/ clean-VM pending/);
  assert.match(doc, /PACK-02 is not green/);
  assert.match(doc, /oneClick: false/);
  assert.match(doc, /perMachine: false/);
  assert.match(doc, /Unsigned \(\*\*R-9\*\*\)/);
  assert.match(doc, /Upgrade \(install A then B\)/);
  assert.doesNotMatch(doc, /matrix is green/i);
});