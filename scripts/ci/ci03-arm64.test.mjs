import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { repositoryRoot } from './repo.mjs';
import {
  BOOT_TEST_STATE,
  BUILDER_VERSION,
  CI03_ID,
  ELECTRON_VERSION,
  HARDWARE_STATE,
  LINUX_ARM_RUNNER,
  LINUX_CORE_TRIPLE,
  WINDOWS_CORE_TRIPLE,
  cargoLinuxArm64Core,
  cargoWindowsArm64Core,
  ci03Report,
  electronBuilderLinuxArm64,
  electronBuilderWinArm64,
  rustupWindowsArm64Target,
} from '../migration/ci03-arm64.mjs';

const SCRIPT = path.join(repositoryRoot, 'scripts', 'migration', 'ci03-arm64.mjs');

test('CI-03 assist prints arm64 triples and does not execute cargo', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.id, CI03_ID);
  assert.equal(payload.dry, true);
  assert.equal(payload.executedCargo, false);
  assert.equal(payload.executedElectronBuilder, false);
  assert.equal(payload.electron, ELECTRON_VERSION);
  assert.equal(payload.electronBuilder, BUILDER_VERSION);
  assert.equal(payload.electronUpdater, false);
  assert.equal(payload.ciYmlEdited, false);
  assert.equal(payload.provenance, 'BLOCKED');
  assert.equal(payload.protocolHardCapMiB, 32);
  assert.equal(payload.qmApiRs, false);
  assert.equal(payload.windows.triple, WINDOWS_CORE_TRIPLE);
  assert.equal(payload.linux.triple, LINUX_CORE_TRIPLE);
  assert.equal(payload.linux.runner, LINUX_ARM_RUNNER);
  assert.equal(payload.windows.bootTest, BOOT_TEST_STATE);
  assert.equal(payload.linux.bootTest, BOOT_TEST_STATE);
  assert.equal(payload.windows.hardware, HARDWARE_STATE);
  assert.equal(payload.linux.hardware, HARDWARE_STATE);
  assert.match(result.stdout, /aarch64-pc-windows-msvc/);
  assert.match(result.stdout, /aarch64-unknown-linux-gnu/);
  assert.match(result.stdout, /ubuntu-24\.04-arm/);
  assert.match(result.stdout, /electron-builder .* --win --arm64/);
  assert.match(result.stdout, /electron-builder .* --linux --arm64/);
  assert.match(result.stdout, /boot-test pending/);
  assert.doesNotMatch(result.stdout, /"checked":\s*true/);
});

test('CI-03 command helpers name the triples without spawning cargo', () => {
  assert.equal(rustupWindowsArm64Target(), 'rustup target add aarch64-pc-windows-msvc');
  assert.equal(
    cargoWindowsArm64Core(),
    'cargo build -p yaqmc-core --release --target aarch64-pc-windows-msvc',
  );
  assert.equal(
    cargoLinuxArm64Core(),
    'cargo build -p yaqmc-core --release --target aarch64-unknown-linux-gnu',
  );
  assert.equal(
    electronBuilderWinArm64(),
    'electron-builder --projectDir apps/desktop --config electron-builder.yml --win --arm64',
  );
  assert.equal(
    electronBuilderLinuxArm64(),
    'electron-builder --projectDir apps/desktop --config electron-builder.yml --linux --arm64',
  );
  const report = ci03Report({ now: () => '2026-08-17' });
  assert.equal(report.date, '2026-08-17');
  assert.equal(report.executedCargo, false);
});

test('CI-03 script source never spawns cargo or electron-builder', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /spawn(?:Sync)?\(/);
  assert.doesNotMatch(source, /exec(?:File)?(?:Sync)?\(/);
  assert.doesNotMatch(source, /child_process/);
  assert.match(source, /aarch64-pc-windows-msvc/);
  assert.match(source, /ubuntu-24\.04-arm/);
  assert.match(source, /aarch64-unknown-linux-gnu/);
});
